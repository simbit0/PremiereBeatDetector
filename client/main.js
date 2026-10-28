var csInterface = new CSInterface();
var wavesurfer;
var wsRegions;
var audioBuffer = null;
var allDetectedBeats = []; // Stores all raw detected beats
var filteredBeats = []; // Stores beats after subdivision
var filteredBeatColorIndexes = []; // Keeps each generated marker's Premiere color aligned with its beat.
var beatRegions = []; // Keeps green WaveSurfer regions so slider updates do not blank the waveform.
var firstBeatRegion = null; // Keeps the red first-beat region independent from the green beat list.
var subdivision = 1; // 1, 2, or 4
var clipStartOffset = 0; // Start time of the clip on the timeline
var autoAnalyzeTimer = null; // Debounce automatic analysis across decode/ready events
var manualPreviewFrame = null; // Coalesces rapid manual-slider input into one visual update per frame.
var markerColorMode = 'accent'; // 'single', 'accent' (downbeat + other beats) or 'cycle' (one color per beat in the bar).
var singleMarkerColorIndex = 0; // Green is Premiere's default marker color.
var downbeatColorIndex = 1; // Red for the first beat of every bar.
var otherBeatColorIndex = 0; // Green for the remaining beats of the bar.
var phraseLengthBars = 0; // 0 = one downbeat color; 2, 4 or 8 = downbeat color changes with every phrase of that many bars.
var phraseShiftBars = 0; // Bars of intro before phrase 1 (0 = phrase 1 starts at Bar 1). Not saved: it belongs to each song.
var phraseColorCycle = [1, 4, 3, 2]; // Red, Yellow, Orange, Purple, repeating every four phrases.
var phraseColorMode = 'phrase'; // 'phrase' = one color per phrase; 'bar' = one color per bar inside the phrase, repeated every phrase.
var phraseBarColorCycle = [1, 4, 3, 2, 6, 7, 5, 2]; // Red, Yellow, Orange, Purple, Blue, Cyan, White, Purple (bars 4 and 8 share the cadence color).
var markerColorCycle = [0, 1, 2, 3]; // Per-beat colors, indexed by beat position inside the bar.
var PREMIERE_MARKER_COLORS = ['Green', 'Red', 'Purple', 'Orange', 'Yellow', 'White', 'Blue', 'Cyan']; // Matches Premiere's marker palette indexes.
var MARKER_COLOR_SETTINGS_STORAGE_KEY = 'com.antigravity.beatdetector.markerColors'; // Shares color preferences across Premiere projects for this CEP extension.
var markerCreationJob = null; // Tracks the asynchronous Premiere marker job so the panel can stop between batches.
var MARKER_CREATION_BATCH_SIZE = 25; // Keeps each ExtendScript call short enough for the Stop button to stay responsive.

// ---- Time signature, phrases and beat map state ----
var beatsPerBar = 4; // Beats grouped into one bar (3 for 3/4, 4 for 4/4). Never changes the BPM.
var downbeatShift = 0; // Rotates which grid beat is beat 1 of the bar, from 0 to beatsPerBar - 1, without moving any beat.
var markerScope = 'all'; // 'all' marks every beat kept by the subdivision; 'bars' marks bar starts only.
var filteredBeatLabels = []; // Marker name and comment for every generated marker, aligned with filteredBeats.
var clipInPointSeconds = 0; // Source time where the selected timeline clip starts playing.
var clipOutPointSeconds = null; // Source time where the selected timeline clip stops playing (null when unknown).
var METER_SETTINGS_STORAGE_KEY = 'com.antigravity.beatdetector.meter'; // Time signature and marks preferences.
var beatMapData = null; // Beat map imported from a Rhythm Map / Beat This JSON (times relative to the audio file).
var beatMapSource = 'exact'; // 'exact' = markers on the map's beats; 'grid' = constant-tempo grid fitted to the map.
var beatMapSkipUnstable = true; // Drop beats inside rhythm sections whose stability is below the threshold.
var beatMapBarInfo = null; // Exact mode only: {pos, bar, len, pickup} for every entry of allDetectedBeats.
var beatMapReferenceTime = null; // Map modes: time of the reference downbeat, used instead of the First Beat Offset slider.
var BEAT_MAP_STABILITY_THRESHOLD = 0.5;
var RHYTHM_MAP_SETTINGS_STORAGE_KEY = 'com.antigravity.beatdetector.rhythmMap'; // Path and version of rhythm-map.exe.
var RHYTHM_MAP_DIRECT_EXTENSIONS = ['.wav', '.mp3', '.flac', '.ogg']; // Formats Rhythm Map documents; others go through a temporary WAV.
var rhythmMapExePath = null;
var rhythmMapVersion = '';
var rhythmMapChild = null; // Running rhythm-map process, if any.
var rhythmMapTimer = null;
var rhythmMapCancelled = false;
var currentAudioPath = null; // File-system path of the loaded audio (null for browser object URLs).
var deleteConfirmTimer = null;
var PREMIERE_MARKER_PREVIEW_RGB = ['64, 200, 64', '230, 60, 60', '170, 80, 220', '240, 140, 40', '235, 215, 50', '235, 235, 235', '60, 120, 230', '50, 200, 220']; // Approximate on-screen colors for the waveform preview.

function toWaveSurferUrl(pathOrUrl) {
    // Keep already valid URLs untouched (http, https, file, blob, etc.).
    if (!pathOrUrl || /^[a-z]+:\/\//i.test(pathOrUrl) || pathOrUrl.indexOf('blob:') === 0) {
        return pathOrUrl;
    }

    // Convert Windows backslashes to slashes and build a file:// URL for local files.
    var normalizedPath = pathOrUrl.replace(/\\/g, '/');
    if (/^[a-zA-Z]:\//.test(normalizedPath)) {
        return 'file:///' + encodeURI(normalizedPath);
    }

    // Convert absolute Unix-like paths to file:// URLs.
    if (normalizedPath.charAt(0) === '/') {
        return 'file://' + encodeURI(normalizedPath);
    }

    return pathOrUrl;
}

var CEP_THEME_COLOR_CHANGED_EVENT = 'com.adobe.csxs.events.ThemeColorChanged';

function clampThemeChannel(value) {
    // Keep CEP RGB channels inside the valid CSS color range.
    var numericValue = Number(value);
    if (!isFinite(numericValue)) {
        return null;
    }

    return Math.max(0, Math.min(255, Math.round(numericValue)));
}

function readThemeRgbTriplet(value) {
    // Read direct CEP RGB payloads shaped as { red, green, blue }.
    if (!value || typeof value !== 'object') {
        return null;
    }

    var red = clampThemeChannel(value.red);
    var green = clampThemeChannel(value.green);
    var blue = clampThemeChannel(value.blue);
    if (red === null || green === null || blue === null) {
        return null;
    }

    return { red: red, green: green, blue: blue };
}

function readThemeColor(value) {
    // Support both CEP RGBColor and UIColor.color shapes from appSkinInfo.
    return readThemeRgbTriplet(value) || (value && readThemeRgbTriplet(value.color));
}

function mixThemeColor(left, right, rightWeight) {
    // Blend two RGB colors so derived surfaces stay near Premiere's host color.
    var clampedWeight = Math.max(0, Math.min(1, rightWeight));
    var leftWeight = 1 - clampedWeight;
    return {
        red: Math.round(left.red * leftWeight + right.red * clampedWeight),
        green: Math.round(left.green * leftWeight + right.green * clampedWeight),
        blue: Math.round(left.blue * leftWeight + right.blue * clampedWeight)
    };
}

function offsetThemeColor(color, delta) {
    // Nudge a neutral color brighter or darker without leaving RGB bounds.
    return {
        red: Math.max(0, Math.min(255, Math.round(color.red + delta))),
        green: Math.max(0, Math.min(255, Math.round(color.green + delta))),
        blue: Math.max(0, Math.min(255, Math.round(color.blue + delta)))
    };
}

function themeLuminance(color) {
    // Estimate perceived brightness to separate Light, Dark, and Darkest Premiere skins.
    return (0.2126 * color.red + 0.7152 * color.green + 0.0722 * color.blue) / 255;
}

function normalizePanelBackground(color) {
    // Keep the main panel close to Premiere's host background, including Darkest mode.
    var luminance = themeLuminance(color);
    if (luminance <= 0.16) {
        return mixThemeColor(color, { red: 24, green: 24, blue: 24 }, luminance <= 0.04 ? 0.65 : 0.12);
    }
    if (luminance <= 0.32) {
        return mixThemeColor(color, { red: 58, green: 58, blue: 58 }, 0.42);
    }
    if (luminance >= 0.7) {
        return mixThemeColor(color, { red: 246, green: 246, blue: 246 }, 0.72);
    }
    if (luminance >= 0.55) {
        return mixThemeColor(color, { red: 242, green: 242, blue: 242 }, 0.5);
    }

    return color;
}

function setThemeColorVariable(name, color) {
    // Publish each token as a normal CSS color and as an RGB triplet for rgba().
    document.documentElement.style.setProperty(name, 'rgb(' + color.red + ', ' + color.green + ', ' + color.blue + ')');
    document.documentElement.style.setProperty(name + '-rgb', color.red + ', ' + color.green + ', ' + color.blue);
}

function readHostSkinInfo() {
    // Read the current CEP host theme; return null during local browser testing.
    try {
        if (!window.__adobe_cep__ || typeof window.__adobe_cep__.getHostEnvironment !== 'function') {
            return null;
        }

        var hostEnvironment = JSON.parse(window.__adobe_cep__.getHostEnvironment());
        return hostEnvironment && hostEnvironment.appSkinInfo ? hostEnvironment.appSkinInfo : null;
    } catch (e) {
        console.warn('[Theme] Unable to read Premiere theme:', e);
        return null;
    }
}

function applyPremierePanelTheme() {
    // Convert Premiere appSkinInfo into stable panel tokens used by the CSS.
    var skinInfo = readHostSkinInfo();
    if (!skinInfo) {
        return;
    }

    var panelBackground = readThemeColor(skinInfo.panelBackgroundColorSRGB) ||
        readThemeColor(skinInfo.panelBackgroundColor) ||
        { red: 48, green: 48, blue: 48 };
    var highlightColor = readThemeColor(skinInfo.systemHighlightColor) || { red: 70, green: 137, blue: 255 };
    var hostLuminance = themeLuminance(panelBackground);
    var base = normalizePanelBackground(panelBackground);
    var isLightTheme = hostLuminance >= 0.55;
    var isDarkestTheme = hostLuminance <= 0.18;
    var textPrimary = isLightTheme ? { red: 36, green: 36, blue: 36 } : { red: 236, green: 236, blue: 236 };
    var textMuted = mixThemeColor(textPrimary, base, isLightTheme ? 0.58 : 0.44);
    var accentSeed = mixThemeColor(highlightColor, { red: 0, green: 100, blue: 203 }, 0.72);
    var accent = isLightTheme ? offsetThemeColor(accentSeed, -8) : offsetThemeColor(accentSeed, 10);

    document.documentElement.dataset.themeVariant = isLightTheme ? 'light' : isDarkestTheme ? 'darkest' : 'dark';
    setThemeColorVariable('--bg-primary', base);
    setThemeColorVariable('--bg-surface', offsetThemeColor(base, isLightTheme ? -7 : isDarkestTheme ? 8 : 6));
    setThemeColorVariable('--bg-soft', offsetThemeColor(base, isLightTheme ? -3 : isDarkestTheme ? 13 : 10));
    setThemeColorVariable('--bg-input', offsetThemeColor(base, isLightTheme ? -14 : isDarkestTheme ? -2 : -1));
    setThemeColorVariable('--bg-hover', offsetThemeColor(base, isLightTheme ? -17 : 20));
    setThemeColorVariable('--text-primary', textPrimary);
    setThemeColorVariable('--text-muted', textMuted);
    setThemeColorVariable('--accent', accent);
    setThemeColorVariable('--accent-hover', offsetThemeColor(accent, isLightTheme ? -10 : 18));
    setThemeColorVariable('--accent-active', offsetThemeColor(accent, isLightTheme ? -22 : -18));
    setThemeColorVariable('--border', offsetThemeColor(base, isLightTheme ? -28 : 16));
    setThemeColorVariable('--border-strong', offsetThemeColor(base, isLightTheme ? -42 : 24));
    setThemeColorVariable('--button-primary-text', themeLuminance(accent) >= 0.5 ? { red: 18, green: 18, blue: 18 } : { red: 246, green: 246, blue: 246 });

    var baseFontFamily = String(skinInfo.baseFontFamily || '').trim();
    if (baseFontFamily) {
        document.documentElement.style.setProperty('--ui-font-family', '"' + baseFontFamily + '", "Segoe UI", "San Francisco", sans-serif');
    }
}

function getCssVariable(name, fallback) {
    // Read a resolved CSS custom property for JS-owned canvas colors.
    var value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
}

function refreshWaveformTheme() {
    // Update WaveSurfer colors after Premiere theme changes when supported by the bundled version.
    if (wavesurfer && typeof wavesurfer.setOptions === 'function') {
        wavesurfer.setOptions({
            waveColor: getCssVariable('--accent', '#4a90e2'),
            progressColor: getCssVariable('--accent-active', '#d0021b'),
            cursorColor: getCssVariable('--text-primary', '#ffffff')
        });
    }
}

function bindPremiereThemeListener() {
    // Subscribe once so the panel follows Premiere light/dark changes without a reload.
    if (!window.__adobe_cep__ || typeof window.__adobe_cep__.addEventListener !== 'function') {
        return;
    }

    window.__adobe_cep__.addEventListener(CEP_THEME_COLOR_CHANGED_EVENT, function () {
        applyPremierePanelTheme();
        refreshWaveformTheme();
    });
}

document.addEventListener('DOMContentLoaded', function () {
    applyPremierePanelTheme();
    bindPremiereThemeListener();
    initWaveSurfer();
    setupEventListeners();
    checkForUpdates();
});

// ============================================================================
// UPDATE SYSTEM
// ============================================================================

const GITHUB_REPO = 'CyrilG93/PremiereBeatDetector';
const PRODUCT_PAGE_URL = 'https://www.cyrilplugin.com/beat-detector';
let CURRENT_VERSION = '1.2.4';

// Open product and update links through CEP, with a browser fallback for local testing.
function openExternalUrl(url) {
    try {
        if (csInterface && typeof csInterface.openURLInDefaultBrowser === 'function') {
            csInterface.openURLInDefaultBrowser(url);
            return;
        }
    } catch (e) {
        console.error('[Link] Error opening URL through CEP:', e);
    }

    try {
        var popup = window.open(url, '_blank');
        if (!popup) {
            window.location.href = url;
        }
    } catch (fallbackError) {
        console.error('[Link] Browser fallback failed:', fallbackError);
    }
}

// Keep the existing badge layout while making the version clickable from mouse and keyboard.
function bindVersionBadgeLink(versionBadge, localVersion) {
    versionBadge.setAttribute('role', 'button');
    versionBadge.setAttribute('tabindex', '0');
    versionBadge.setAttribute('title', 'Open Beat Detector page');
    versionBadge.setAttribute('aria-label', 'Open Beat Detector page for version ' + localVersion);
    versionBadge.onclick = function () {
        openExternalUrl(PRODUCT_PAGE_URL);
    };
    versionBadge.onkeydown = function (event) {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openExternalUrl(PRODUCT_PAGE_URL);
        }
    };
}

/**
 * Compare two version strings (e.g. "1.0.0" vs "1.0.1")
 */
function compareVersions(v1, v2) {
    const p1 = v1.replace(/^v/, '').split('.').map(Number);
    const p2 = v2.replace(/^v/, '').split('.').map(Number);
    const len = Math.max(p1.length, p2.length);

    for (let i = 0; i < len; i++) {
        const num1 = p1[i] || 0;
        const num2 = p2[i] || 0;
        if (num1 > num2) return 1;
        if (num1 < num2) return -1;
    }
    return 0;
}

/**
 * Get current version from manifest
 */
function getAppVersion() {
    try {
        if (window.cep && window.cep.fs) {
            const path = window.cep.fs.readFile(csInterface.getSystemPath(SystemPath.EXTENSION) + "/CSXS/manifest.xml");
            if (path.data) {
                const match = path.data.match(/ExtensionBundleVersion="([^"]+)"/);
                if (match && match[1]) {
                    return match[1];
                }
            }
        }
    } catch (e) {
        console.error('[Update] Error reading manifest:', e);
    }
    return CURRENT_VERSION;
}

/**
 * Check for updates on GitHub
 */
async function checkForUpdates() {
    console.log('[Update] Checking for updates...');
    const localVersion = getAppVersion();
    console.log('[Update] Local version:', localVersion);

    // Update settings badge
    const versionBadge = document.getElementById('versionInfo');
    if (versionBadge) {
        versionBadge.textContent = 'v' + localVersion;
        bindVersionBadgeLink(versionBadge, localVersion);
    }

    try {
        // Use standard fetch or Node https if available
        // Premiere extensions run in CEF, so fetch is available but CORS might be an issue.
        // Node is enabled in manifest, so we can use it.
        if (window.require) {
            const https = require('https');
            const options = {
                hostname: 'api.github.com',
                path: `/repos/${GITHUB_REPO}/releases/latest`,
                method: 'GET',
                headers: {
                    'User-Agent': 'PremiereCommon-UpdateCheck'
                }
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => {
                    handleUpdateResponse(data, localVersion);
                });
            });

            req.on('error', (e) => {
                console.error('[Update] Network error:', e);
            });

            req.end();
        } else {
            // Fallback to fetch (might fail due to CORS)
            const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`);
            if (response.ok) {
                const data = await response.text();
                handleUpdateResponse(data, localVersion);
            }
        }

    } catch (e) {
        console.error('[Update] Unexpected error:', e);
    }
}

function handleUpdateResponse(data, localVersion) {
    try {
        const release = JSON.parse(data);
        const latestVersion = release.tag_name.replace(/^v/, '');

        console.log('[Update] Latest version:', latestVersion);

        if (compareVersions(latestVersion, localVersion) > 0) {
            console.log('[Update] New version available!');

            // Find zip asset
            const zipAsset = release.assets.find(asset => asset.name.endsWith('.zip'));
            const downloadUrl = zipAsset ? zipAsset.browser_download_url : release.html_url;

            showUpdateBanner(downloadUrl);
        } else {
            console.log('[Update] App is up to date.');
        }
    } catch (e) {
        console.error('[Update] Error parsing response:', e);
    }
}

/**
 * Show update banner
 */
function showUpdateBanner(downloadUrl) {
    const banner = document.getElementById('updateBanner');
    if (banner) {
        banner.style.display = 'block';

        // i18n logic based on Host Locale
        let locale = 'en_US';
        try {
            locale = csInterface.getHostEnvironment().appLocale;
        } catch (e) { }

        const isFrench = locale && locale.toLowerCase().startsWith('fr');
        banner.textContent = isFrench
            ? '🚀 Nouvelle version disponible ! Cliquez pour mettre à jour.'
            : '🚀 New version available! Click to update.';

        banner.onclick = function () {
            if (downloadUrl) {
                openExternalUrl(downloadUrl);
            }
        };
    }
}

function initWaveSurfer() {
    wavesurfer = WaveSurfer.create({
        container: '#waveform',
        waveColor: getCssVariable('--accent', '#4a90e2'),
        progressColor: getCssVariable('--accent-active', '#d0021b'),
        cursorColor: getCssVariable('--text-primary', '#ffffff'),
        height: 128,
        normalize: true,
        minPxPerSec: 100, // Increased for better zoom
        scrollParent: true,
        hideScrollbar: false
    });

    // Initialize Regions plugin
    wsRegions = wavesurfer.registerPlugin(WaveSurfer.Regions.create());

    // Initialize Minimap plugin for timeline-style navigation with handles
    var minimap = wavesurfer.registerPlugin(WaveSurfer.Minimap.create({
        container: '#wave-minimap',
        waveColor: getCssVariable('--bg-hover', '#555555'),
        progressColor: getCssVariable('--text-muted', '#999999'),
        cursorColor: getCssVariable('--text-primary', '#ffffff'),
        height: 40,
        overlayColor: 'rgba(100, 100, 100, 0.4)',
        insertPosition: 'afterend'
    }));

    wavesurfer.on('load', function () {
        // Keep users informed during fetch/decode, especially on slower CEP hosts.
        document.getElementById('status-msg').textContent = "Loading audio data...";
    });

    wavesurfer.on('decode', function () {
        // Prefer decode event for stable buffer availability on older CEP runtimes.
        audioBuffer = wavesurfer.getDecodedData();
        scheduleAutoAnalysis('decode');
    });

    wavesurfer.on('ready', function () {
        document.getElementById('status-msg').textContent = "Audio loaded. Preparing analysis...";

        // Keep any existing decoded buffer if this host fires ready before decode.
        var decoded = wavesurfer.getDecodedData();
        if (decoded) {
            audioBuffer = decoded;
        }
        scheduleAutoAnalysis('ready');
    });

    wavesurfer.on('error', function (error) {
        console.error('[WaveSurfer] Audio load/decode error:', error);
        document.getElementById('status-msg').textContent =
            "Audio loaded but decode failed. Try 'Select Audio File' on a local file.";
    });
}

function scheduleAutoAnalysis(sourceEvent) {
    if (autoAnalyzeTimer) {
        clearTimeout(autoAnalyzeTimer);
    }

    // Debounce so decode/ready firing order differences do not trigger duplicate runs.
    autoAnalyzeTimer = setTimeout(function () {
        runAutoAnalysis(sourceEvent);
    }, 120);
}

function runAutoAnalysis(sourceEvent) {
    try {
        // Re-check decoded data at runtime for CEP hosts where decode arrives late.
        var decoded = wavesurfer.getDecodedData();
        if (decoded) {
            audioBuffer = decoded;
        }

        if (!audioBuffer || typeof audioBuffer.getChannelData !== 'function') {
            document.getElementById('status-msg').textContent =
                "Audio loaded, but analysis data is unavailable on this host.";
            console.warn('[Analysis] Missing decoded buffer after', sourceEvent);
            return;
        }

        document.getElementById('status-msg').textContent = "Audio loaded. Analyzing...";

        // Quick BPM detection used to initialize the manual grid controls.
        var threshold = 0.35;
        var minDistance = 0.45;
        var detectionResult = detectFirstBeatAndTempo(audioBuffer, threshold, minDistance, true);

        // Update BPM slider with detected tempo.
        document.getElementById('bpm').value = Math.round(detectionResult.tempo);
        document.getElementById('bpm-val').textContent = Math.round(detectionResult.tempo) + ' BPM';

        // Update first beat offset.
        document.getElementById('first-beat').value = detectionResult.firstBeat;
        document.getElementById('first-beat-val').textContent = detectionResult.firstBeat.toFixed(3) + 's';

        analyzeBeats();
    } catch (e) {
        console.error('[Analysis] Auto-analysis failed:', e);
        document.getElementById('status-msg').textContent =
            "Analysis failed on this host. Open Console (F12) for details.";
    }
}

function setupEventListeners() {
    var detectionMode = 'manual'; // 'manual' or 'auto'

    // Restore the user's last color choices before building the custom palette controls.
    restoreMarkerColorSettings();
    restoreMeterSettings();

    // Mode switching
    document.getElementById('btn-mode-manual').addEventListener('click', function () {
        detectionMode = 'manual';
        window.detectionMode = 'manual'; // Update global immediately
        document.getElementById('btn-mode-manual').classList.add('active');
        document.getElementById('btn-mode-auto').classList.remove('active');
        document.getElementById('btn-mode-map').classList.remove('active');
        document.getElementById('map-controls').style.display = 'none';
        document.getElementById('manual-controls').style.display = 'block';
        document.getElementById('auto-controls').style.display = 'none';
        if (audioBuffer) analyzeBeats();
    });

    document.getElementById('btn-mode-auto').addEventListener('click', function () {
        detectionMode = 'auto';
        window.detectionMode = 'auto'; // Update global immediately
        document.getElementById('btn-mode-auto').classList.add('active');
        document.getElementById('btn-mode-manual').classList.remove('active');
        document.getElementById('btn-mode-map').classList.remove('active');
        document.getElementById('map-controls').style.display = 'none';
        document.getElementById('manual-controls').style.display = 'none';
        document.getElementById('auto-controls').style.display = 'block';
        if (audioBuffer) analyzeBeats();
    });

    // Third detection mode driven by an imported beat map.
    document.getElementById('btn-mode-map').addEventListener('click', function () {
        detectionMode = 'map';
        window.detectionMode = 'map';
        document.getElementById('btn-mode-map').classList.add('active');
        document.getElementById('btn-mode-manual').classList.remove('active');
        document.getElementById('btn-mode-auto').classList.remove('active');
        document.getElementById('manual-controls').style.display = 'none';
        document.getElementById('auto-controls').style.display = 'none';
        document.getElementById('map-controls').style.display = 'block';
        updateBeatMapSummary();
        if (audioBuffer) analyzeBeats();
    });
    setupBeatMapControls();
    setupRhythmMapControls();
    setupDeleteClipMarkersButton();

    // Store mode globally
    window.detectionMode = detectionMode;

    document.getElementById('btn-select-file').addEventListener('click', function () {
        if (window.cep) {
            var result = window.cep.fs.showOpenDialog(false, false, "Select Audio File", null, ["mp3", "wav", "aiff"]);
            if (result.data && result.data.length > 0) {
                loadAudio(result.data[0]);
                clipStartOffset = 0;
                clipInPointSeconds = 0;
                clipOutPointSeconds = null;
            }
        } else {
            var input = document.createElement('input');
            input.type = 'file';
            input.accept = 'audio/*';
            input.onchange = function (e) {
                var file = e.target.files[0];
                if (file) {
                    var url = URL.createObjectURL(file);
                    loadAudio(url, file.name);
                }
            };
            input.click();
        }
    });

    document.getElementById('btn-load-active').addEventListener('click', function () {
        document.getElementById('status-msg').textContent = "Getting selected clip...";
        csInterface.evalScript("BeatDetector_getSelectedClipPath()", function (result) {
            console.log("getSelectedClipPath result:", result);
            try {
                var data = JSON.parse(result);
                if (data.error) {
                    document.getElementById('status-msg').textContent = "Error: " + data.error;
                    alert("Error loading clip: " + data.error);
                } else if (data.path) {
                    // Beat times are measured from the start of the media file, so a clip trimmed
                    // at its head must subtract its In point: sequence time = clip start + (beat - In point).
                    clipInPointSeconds = data.inPointSeconds || 0;
                    clipOutPointSeconds = typeof data.outPointSeconds === 'number' ? data.outPointSeconds : null;
                    clipStartOffset = (data.startSeconds || 0) - clipInPointSeconds;
                    // Support both Windows and macOS path separators.
                    var clipName = data.name || data.path.split(/[\\/]/).pop();
                    loadAudio(data.path, clipName);
                    document.getElementById('status-msg').textContent = "Loaded clip (Start: " + (data.startSeconds || 0).toFixed(2) +
                        "s, In: " + clipInPointSeconds.toFixed(2) + "s)";
                }
            } catch (e) {
                document.getElementById('status-msg').textContent = "Error parsing response: " + result;
                console.error("Parse error:", e);
            }
        });
    });

    document.getElementById('btn-create-markers').addEventListener('click', createMarkersInPremiere);

    // Threshold slider with live update
    document.getElementById('threshold').addEventListener('input', function (e) {
        document.getElementById('threshold-val').textContent = e.target.value + '%';
    });

    // Min distance slider with live update
    document.getElementById('min-distance').addEventListener('input', function (e) {
        document.getElementById('min-distance-val').textContent = e.target.value + 'ms';
    });

    // BPM input with live update
    document.getElementById('bpm').addEventListener('input', function (e) {
        document.getElementById('bpm-val').textContent = e.target.value + ' BPM';
    });

    // First beat offset input with live update
    document.getElementById('first-beat').addEventListener('input', function (e) {
        document.getElementById('first-beat-val').textContent = parseFloat(e.target.value).toFixed(3) + 's';
    });

    // Subdivision buttons
    document.getElementById('btn-sub-1').addEventListener('click', function () { setSubdivision(1, this); });
    document.getElementById('btn-sub-2').addEventListener('click', function () { setSubdivision(2, this); });
    document.getElementById('btn-sub-4').addEventListener('click', function () { setSubdivision(4, this); });

    // One color, downbeat + other beats, or one color per beat position in the bar.
    var colorModeButtons = document.querySelectorAll('#marker-color-mode-buttons button');
    for (var modeButtonIndex = 0; modeButtonIndex < colorModeButtons.length; modeButtonIndex++) {
        colorModeButtons[modeButtonIndex].addEventListener('click', function () {
            markerColorMode = this.getAttribute('data-color-mode');
            saveMarkerColorSettings();
            updateMarkerColorControls();
            updateFilteredBeats();
        });
    }
    document.getElementById('marker-color-downbeat').setAttribute('data-color-index', downbeatColorIndex);
    setupMarkerColorPicker('marker-color-downbeat', function (colorIndex) {
        downbeatColorIndex = colorIndex;
        saveMarkerColorSettings();
        updateFilteredBeats();
    });
    document.getElementById('marker-color-other').setAttribute('data-color-index', otherBeatColorIndex);
    setupMarkerColorPicker('marker-color-other', function (colorIndex) {
        otherBeatColorIndex = colorIndex;
        saveMarkerColorSettings();
        updateFilteredBeats();
    });
    setupPhraseControls();
    setupMeterControls();
    document.getElementById('marker-color-single').setAttribute('data-color-index', singleMarkerColorIndex);
    setupMarkerColorPicker('marker-color-single', function (colorIndex) {
        singleMarkerColorIndex = colorIndex;
        saveMarkerColorSettings();
        updateFilteredBeats();
    });
    for (var colorSlot = 0; colorSlot < markerColorCycle.length; colorSlot++) {
        (function (slot) {
            document.getElementById('marker-color-cycle-' + slot).setAttribute('data-color-index', markerColorCycle[slot]);
            setupMarkerColorPicker('marker-color-cycle-' + slot, function (colorIndex) {
                markerColorCycle[slot] = colorIndex;
                saveMarkerColorSettings();
                updateFilteredBeats();
            });
        }(colorSlot));
    }
    updateMarkerColorControls();

    // Click track
    document.getElementById('btn-play-click').addEventListener('click', playClickTrack);

    // Spacebar to play/pause click track - simple and reliable
    document.addEventListener('keydown', function (e) {
        if (e.code === 'Space' || e.key === ' ') {
            // Prevent default only if we have audio loaded
            if (audioBuffer) {
                e.preventDefault();
                e.stopPropagation();
                // Trigger click track button
                document.getElementById('btn-play-click').click();
            }
        }
    });
}

function setSubdivision(val, btn) {
    subdivision = val;

    // Update UI
    // Only the subdivision buttons; the old selector also cleared Detection Mode and other groups.
    document.querySelectorAll('#subdivision-buttons button').forEach(function (b) { b.classList.remove('active'); });
    btn.classList.add('active');

    // Recalculate the visible color slots before regenerating the marker color list.
    updateMarkerColorControls();
    updateFilteredBeats();
}

function getPremiereMarkerColorIndex(value, fallback) {
    // Accept only Premiere's documented marker palette indexes (0 Green through 7 Cyan).
    var colorIndex = parseInt(value, 10);
    if (isNaN(colorIndex) || colorIndex < 0 || colorIndex > 7) {
        return fallback;
    }
    return colorIndex;
}

function restoreMarkerColorSettings() {
    // Read saved colors from CEP's local storage, while keeping defaults if storage is unavailable or malformed.
    try {
        var savedSettings = window.localStorage.getItem(MARKER_COLOR_SETTINGS_STORAGE_KEY);
        if (!savedSettings) {
            return;
        }
        var parsedSettings = JSON.parse(savedSettings);
        // Migrate the original on/off setting when no color mode has been saved yet.
        if (parsedSettings.colorMode === 'single' || parsedSettings.colorMode === 'accent' || parsedSettings.colorMode === 'cycle') {
            markerColorMode = parsedSettings.colorMode;
        } else {
            markerColorMode = parsedSettings.enabled === true ? 'cycle' : 'single';
        }
        singleMarkerColorIndex = getPremiereMarkerColorIndex(parsedSettings.singleColorIndex, 0);
        downbeatColorIndex = getPremiereMarkerColorIndex(parsedSettings.downbeatColorIndex, 1);
        otherBeatColorIndex = getPremiereMarkerColorIndex(parsedSettings.otherBeatColorIndex, 0);
        var savedPhraseLength = parseInt(parsedSettings.phraseLengthBars, 10);
        if (savedPhraseLength === 0 || savedPhraseLength === 2 || savedPhraseLength === 4 || savedPhraseLength === 8) {
            phraseLengthBars = savedPhraseLength;
        }
        if (parsedSettings.phraseColorMode === 'phrase' || parsedSettings.phraseColorMode === 'bar') {
            phraseColorMode = parsedSettings.phraseColorMode;
        }
        if (Object.prototype.toString.call(parsedSettings.phraseBarColorCycle) === '[object Array]') {
            for (var phraseBarSlot = 0; phraseBarSlot < phraseBarColorCycle.length; phraseBarSlot++) {
                phraseBarColorCycle[phraseBarSlot] = getPremiereMarkerColorIndex(parsedSettings.phraseBarColorCycle[phraseBarSlot], phraseBarColorCycle[phraseBarSlot]);
            }
        }
        if (Object.prototype.toString.call(parsedSettings.phraseColorCycle) === '[object Array]') {
            for (var phraseSlot = 0; phraseSlot < phraseColorCycle.length; phraseSlot++) {
                phraseColorCycle[phraseSlot] = getPremiereMarkerColorIndex(parsedSettings.phraseColorCycle[phraseSlot], phraseColorCycle[phraseSlot]);
            }
        }
        if (Object.prototype.toString.call(parsedSettings.colorCycle) === '[object Array]') {
            for (var colorSlot = 0; colorSlot < markerColorCycle.length; colorSlot++) {
                markerColorCycle[colorSlot] = getPremiereMarkerColorIndex(parsedSettings.colorCycle[colorSlot], markerColorCycle[colorSlot]);
            }
        }
    } catch (error) {
        console.warn('Unable to restore marker color settings:', error);
    }
}

function saveMarkerColorSettings() {
    // Persist only the color UI preferences so they remain available after opening another Premiere project.
    try {
        window.localStorage.setItem(MARKER_COLOR_SETTINGS_STORAGE_KEY, JSON.stringify({
            enabled: markerColorMode === 'cycle', // Kept so the original 1.2.4 still reads these settings.
            singleColorIndex: singleMarkerColorIndex,
            colorCycle: markerColorCycle,
            colorMode: markerColorMode,
            downbeatColorIndex: downbeatColorIndex,
            otherBeatColorIndex: otherBeatColorIndex,
            phraseLengthBars: phraseLengthBars,
            phraseColorCycle: phraseColorCycle,
            phraseColorMode: phraseColorMode,
            phraseBarColorCycle: phraseBarColorCycle
        }));
    } catch (error) {
        console.warn('Unable to save marker color settings:', error);
    }
}

function closeMarkerColorPickers(exceptPicker) {
    // Close any other open palette before showing the requested popover.
    var pickers = document.querySelectorAll('.marker-color-picker.is-open');
    for (var i = 0; i < pickers.length; i++) {
        if (pickers[i] !== exceptPicker) {
            pickers[i].classList.remove('is-open');
        }
    }
}

function positionMarkerColorMenu(picker) {
    // Keep the fixed popover inside CEP's visible viewport, preferring space above when needed.
    var trigger = picker.querySelector('.marker-color-trigger');
    var menu = picker.querySelector('.marker-color-menu');
    var triggerRect = trigger.getBoundingClientRect();
    var documentHeight = document.documentElement.clientHeight || Infinity;
    var windowHeight = window.innerHeight || Infinity;
    var viewportHeight = Math.min(documentHeight, windowHeight);
    var availableHeight = Math.max(80, viewportHeight - 12);
    menu.style.left = Math.max(4, triggerRect.left) + 'px';
    menu.style.maxHeight = Math.min(164, availableHeight) + 'px';
    menu.style.visibility = 'hidden';

    var menuHeight = menu.offsetHeight;
    var top = triggerRect.bottom + 2;
    if (top + menuHeight > viewportHeight && triggerRect.top - menuHeight - 2 >= 4) {
        top = triggerRect.top - menuHeight - 2;
    } else {
        top = Math.max(4, Math.min(top, viewportHeight - menuHeight - 4));
    }
    menu.style.top = top + 'px';
    menu.style.visibility = 'visible';
}

function setupMarkerColorPicker(pickerId, onChange) {
    // Build an opaque HTML palette so CEP never delegates its dropdown to a clipped native select control.
    var picker = document.getElementById(pickerId);
    var selectedColorIndex = getPremiereMarkerColorIndex(picker.getAttribute('data-color-index'), 0);
    var trigger = document.createElement('button');
    var label = document.createElement('span');
    var arrow = document.createElement('span');
    var menu = document.createElement('div');

    trigger.type = 'button';
    trigger.className = 'marker-color-trigger';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    label.className = 'marker-color-label';
    arrow.className = 'marker-color-arrow';
    arrow.textContent = '▾';
    menu.className = 'marker-color-menu';
    menu.setAttribute('role', 'listbox');
    trigger.appendChild(label);
    trigger.appendChild(arrow);
    picker.appendChild(trigger);
    picker.appendChild(menu);

    function setSelectedColor(colorIndex) {
        // Synchronize the displayed name, data value, and selected menu item for this palette.
        var normalizedColorIndex = getPremiereMarkerColorIndex(colorIndex, 0);
        picker.setAttribute('data-color-index', normalizedColorIndex);
        label.textContent = PREMIERE_MARKER_COLORS[normalizedColorIndex];
        var options = menu.querySelectorAll('.marker-color-option');
        for (var optionIndex = 0; optionIndex < options.length; optionIndex++) {
            options[optionIndex].classList.toggle('is-selected', optionIndex === normalizedColorIndex);
        }
        return normalizedColorIndex;
    }

    for (var colorIndex = 0; colorIndex < PREMIERE_MARKER_COLORS.length; colorIndex++) {
        var option = document.createElement('button');
        option.type = 'button';
        option.className = 'marker-color-option';
        option.setAttribute('role', 'option');
        option.setAttribute('data-color-index', colorIndex);
        option.textContent = PREMIERE_MARKER_COLORS[colorIndex];
        menu.appendChild(option);
    }
    setSelectedColor(selectedColorIndex);

    trigger.addEventListener('click', function () {
        // Toggle the palette and calculate its position only after CSS has made it measurable.
        var willOpen = !picker.classList.contains('is-open');
        closeMarkerColorPickers(picker);
        picker.classList.toggle('is-open', willOpen);
        trigger.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
        if (willOpen) {
            positionMarkerColorMenu(picker);
        }
    });

    menu.addEventListener('click', function (event) {
        // Select a palette entry and immediately close the custom popover.
        var target = event.target;
        var colorIndex = target && target.getAttribute ? target.getAttribute('data-color-index') : null;
        if (colorIndex === null) {
            return;
        }
        picker.classList.remove('is-open');
        trigger.setAttribute('aria-expanded', 'false');
        onChange(setSelectedColor(colorIndex));
    });

    document.addEventListener('click', function (event) {
        // Dismiss the palette when the user continues elsewhere in the panel.
        if (!picker.contains(event.target)) {
            picker.classList.remove('is-open');
            trigger.setAttribute('aria-expanded', 'false');
        }
    });

    document.addEventListener('keydown', function (event) {
        // Let Escape close an open palette without changing its current color.
        if (event.key === 'Escape' && picker.classList.contains('is-open')) {
            picker.classList.remove('is-open');
            trigger.setAttribute('aria-expanded', 'false');
            trigger.focus();
        }
    });
}

function getMarkerColorCycleLength() {
    // The per-beat palette follows the bar, so it has one slot per beat of the time signature.
    return beatsPerBar;
}

function getBeatPositionInBar(beatIndex, firstBeatIndex) {
    // Position 0 is the bar start. The reference beat is the one nearest to First Beat Offset,
    // and downbeatShift moves the bar start forward without moving any beat in time.
    if (beatMapBarInfo) {
        return beatMapBarInfo[beatIndex].pos; // Exact beat map: bars come from the map's downbeats.
    }
    var relativeBeat = beatIndex - firstBeatIndex - downbeatShift;
    return ((relativeBeat % beatsPerBar) + beatsPerBar) % beatsPerBar;
}

function getBarIndexForBeat(beatIndex, firstBeatIndex) {
    // Bars counted from the reference; negative values belong to bars before it.
    if (beatMapBarInfo) {
        return beatMapBarInfo[beatIndex].bar;
    }
    return Math.floor((beatIndex - firstBeatIndex - downbeatShift) / beatsPerBar);
}

function getPhraseIndexForBeat(beatIndex, firstBeatIndex, firstBarIndex) {
    // Phrase 0 starts at Bar (1 + phraseShiftBars); bars before it give negative indexes (the intro).
    var barNumber = getBarIndexForBeat(beatIndex, firstBeatIndex) - firstBarIndex + 1;
    return Math.floor((barNumber - 1 - phraseShiftBars) / phraseLengthBars);
}

function getBarInPhraseForBeat(beatIndex, firstBeatIndex, firstBarIndex) {
    // 0 for the first bar of every phrase; intro bars count backwards from phrase 1.
    var barNumber = getBarIndexForBeat(beatIndex, firstBeatIndex) - firstBarIndex + 1;
    return (((barNumber - 1 - phraseShiftBars) % phraseLengthBars) + phraseLengthBars) % phraseLengthBars;
}

function getMarkerColorIndexForBeat(beatIndex, firstBeatIndex, firstBarIndex) {
    // Keep a single chosen color when color coding is off, regardless of the generated beat position.
    if (markerColorMode === 'single') {
        return singleMarkerColorIndex;
    }

    var positionInBar = getBeatPositionInBar(beatIndex, firstBeatIndex);
    if (markerColorMode === 'accent') {
        if (positionInBar !== 0) {
            return otherBeatColorIndex;
        }
        if (phraseLengthBars > 0 && phraseColorMode === 'bar') {
            // A different color for each bar of the phrase, starting again with every phrase.
            return phraseBarColorCycle[getBarInPhraseForBeat(beatIndex, firstBeatIndex, firstBarIndex || 0)];
        }
        if (phraseLengthBars > 0) {
            // The downbeat color follows the phrase and repeats every four phrases (the intro counts backwards).
            var phraseIndex = getPhraseIndexForBeat(beatIndex, firstBeatIndex, firstBarIndex || 0);
            var cycleLength = phraseColorCycle.length;
            return phraseColorCycle[((phraseIndex % cycleLength) + cycleLength) % cycleLength];
        }
        return downbeatColorIndex;
    }
    return markerColorCycle[positionInBar % getMarkerColorCycleLength()]; // Map bars may be longer than the slots.
}

function updateMarkerColorControls() {
    // Show only the controls that matter for the active color mode.
    var singleColorControl = document.getElementById('single-marker-color-control');
    var accentControls = document.getElementById('marker-color-accent-controls');
    var cycleControls = document.getElementById('marker-color-cycle-controls');
    var cycleLength = getMarkerColorCycleLength();
    singleColorControl.style.display = markerColorMode === 'single' ? 'flex' : 'none';
    accentControls.style.display = markerColorMode === 'accent' ? 'block' : 'none';
    cycleControls.style.display = markerColorMode === 'cycle' ? 'block' : 'none';

    var modeButtons = document.querySelectorAll('#marker-color-mode-buttons button');
    for (var i = 0; i < modeButtons.length; i++) {
        modeButtons[i].classList.toggle('active', modeButtons[i].getAttribute('data-color-mode') === markerColorMode);
    }

    updatePhraseControls();

    if (markerColorMode !== 'cycle') {
        return;
    }

    document.getElementById('marker-color-help').textContent =
        'One color for each beat of the ' + beatsPerBar + '/4 bar. Beats skipped by the subdivision keep their slot unused.';
    for (var slot = 0; slot < markerColorCycle.length; slot++) {
        var colorControl = document.querySelector('[data-color-slot="' + slot + '"]');
        colorControl.style.display = slot < cycleLength ? 'flex' : 'none';
    }
}

// ============================================================================
// Time signature, downbeat shift and marks
// ============================================================================

function restoreMeterSettings() {
    // Time signature and marks are remembered; the downbeat shift is specific to each song and is not.
    try {
        var savedSettings = window.localStorage.getItem(METER_SETTINGS_STORAGE_KEY);
        if (!savedSettings) {
            return;
        }
        var parsedSettings = JSON.parse(savedSettings);
        var savedBeatsPerBar = parseInt(parsedSettings.beatsPerBar, 10);
        if (savedBeatsPerBar === 3 || savedBeatsPerBar === 4) {
            beatsPerBar = savedBeatsPerBar;
        }
        if (parsedSettings.markerScope === 'all' || parsedSettings.markerScope === 'bars') {
            markerScope = parsedSettings.markerScope;
        }
        if (parsedSettings.mapSource === 'exact' || parsedSettings.mapSource === 'grid') {
            beatMapSource = parsedSettings.mapSource;
        }
        if (typeof parsedSettings.mapSkipUnstable === 'boolean') {
            beatMapSkipUnstable = parsedSettings.mapSkipUnstable;
        }
    } catch (error) {
        console.warn('Unable to restore meter settings:', error);
    }
}

function saveMeterSettings() {
    try {
        window.localStorage.setItem(METER_SETTINGS_STORAGE_KEY, JSON.stringify({
            beatsPerBar: beatsPerBar,
            markerScope: markerScope,
            mapSource: beatMapSource,
            mapSkipUnstable: beatMapSkipUnstable
        }));
    } catch (error) {
        console.warn('Unable to save meter settings:', error);
    }
}

function setupMeterControls() {
    var meterButtons = document.querySelectorAll('#meter-buttons button');
    for (var i = 0; i < meterButtons.length; i++) {
        meterButtons[i].addEventListener('click', function () {
            beatsPerBar = parseInt(this.getAttribute('data-beats'), 10);
            downbeatShift = downbeatShift % beatsPerBar; // Keep the shift inside the new bar length.
            saveMeterSettings();
            updateMeterControls();
            updateMarkerColorControls();
            updateFilteredBeats();
        });
    }

    var scopeButtons = document.querySelectorAll('#marker-scope-buttons button');
    for (var j = 0; j < scopeButtons.length; j++) {
        scopeButtons[j].addEventListener('click', function () {
            markerScope = this.getAttribute('data-scope');
            saveMeterSettings();
            updateMeterControls();
            updateFilteredBeats();
        });
    }

    document.getElementById('btn-shift-down').addEventListener('click', function () {
        setDownbeatShift(downbeatShift - 1);
    });
    document.getElementById('btn-shift-up').addEventListener('click', function () {
        setDownbeatShift(downbeatShift + 1);
    });

    updateMeterControls();
}

function setDownbeatShift(value) {
    // Wraps around the bar: shifting a 3/4 bar by +3 is the same as no shift.
    downbeatShift = ((value % beatsPerBar) + beatsPerBar) % beatsPerBar;
    updateMeterControls();
    if (isBeatMapExactActive() && audioBuffer) {
        analyzeBeats(); // Exact beat map: the bars are rebuilt from the shifted downbeat flags.
    } else {
        updateFilteredBeats();
    }
}

function updateMeterControls() {
    var meterButtons = document.querySelectorAll('#meter-buttons button');
    for (var i = 0; i < meterButtons.length; i++) {
        meterButtons[i].classList.toggle('active', parseInt(meterButtons[i].getAttribute('data-beats'), 10) === beatsPerBar);
    }
    var scopeButtons = document.querySelectorAll('#marker-scope-buttons button');
    for (var j = 0; j < scopeButtons.length; j++) {
        scopeButtons[j].classList.toggle('active', scopeButtons[j].getAttribute('data-scope') === markerScope);
    }
    // Subdivision has no effect when only bar starts are marked.
    var subdivisionButtons = document.querySelectorAll('#subdivision-buttons button');
    for (var k = 0; k < subdivisionButtons.length; k++) {
        subdivisionButtons[k].disabled = markerScope === 'bars';
    }
    // Exact beat map: the bars come from the map, so the time signature only sets the per-beat color slots.
    var barsFromMap = isBeatMapExactActive();
    for (var m = 0; m < meterButtons.length; m++) {
        meterButtons[m].disabled = barsFromMap;
    }
    document.getElementById('downbeat-shift-val').textContent = downbeatShift === 0 ? '0' : '+' + downbeatShift;
}

function setupPhraseControls() {
    // Phrase length buttons, phrase start stepper and four phrase color pickers (Downbeat mode only).
    var phraseButtons = document.querySelectorAll('#phrase-length-buttons button');
    for (var i = 0; i < phraseButtons.length; i++) {
        phraseButtons[i].addEventListener('click', function () {
            phraseLengthBars = parseInt(this.getAttribute('data-phrase-bars'), 10);
            if (phraseLengthBars > 0) {
                phraseShiftBars = phraseShiftBars % phraseLengthBars; // Keep the intro shorter than one phrase.
            }
            saveMarkerColorSettings();
            updatePhraseControls();
            updateFilteredBeats();
        });
    }
    document.getElementById('btn-phrase-shift-down').addEventListener('click', function () {
        setPhraseShift(phraseShiftBars - 1);
    });
    document.getElementById('btn-phrase-shift-up').addEventListener('click', function () {
        setPhraseShift(phraseShiftBars + 1);
    });
    var colorModeButtons = document.querySelectorAll('#phrase-color-mode-buttons button');
    for (var m = 0; m < colorModeButtons.length; m++) {
        colorModeButtons[m].addEventListener('click', function () {
            phraseColorMode = this.getAttribute('data-phrase-color-mode');
            saveMarkerColorSettings();
            updatePhraseControls();
            updateFilteredBeats();
        });
    }
    for (var barSlot = 0; barSlot < phraseBarColorCycle.length; barSlot++) {
        (function (phraseBarSlot) {
            document.getElementById('marker-color-phrase-bar-' + phraseBarSlot).setAttribute('data-color-index', phraseBarColorCycle[phraseBarSlot]);
            setupMarkerColorPicker('marker-color-phrase-bar-' + phraseBarSlot, function (colorIndex) {
                phraseBarColorCycle[phraseBarSlot] = colorIndex;
                saveMarkerColorSettings();
                updateFilteredBeats();
            });
        }(barSlot));
    }
    for (var slot = 0; slot < phraseColorCycle.length; slot++) {
        (function (phraseSlot) {
            document.getElementById('marker-color-phrase-' + phraseSlot).setAttribute('data-color-index', phraseColorCycle[phraseSlot]);
            setupMarkerColorPicker('marker-color-phrase-' + phraseSlot, function (colorIndex) {
                phraseColorCycle[phraseSlot] = colorIndex;
                saveMarkerColorSettings();
                updateFilteredBeats();
            });
        }(slot));
    }
}

function setPhraseShift(value) {
    // Wraps around the phrase: with 4-bar phrases, an intro of 4 bars is the same as no intro.
    if (phraseLengthBars <= 0) {
        return;
    }
    phraseShiftBars = ((value % phraseLengthBars) + phraseLengthBars) % phraseLengthBars;
    updatePhraseControls();
    updateFilteredBeats();
}

function updatePhraseControls() {
    var phrasesOn = phraseLengthBars > 0;
    document.getElementById('downbeat-color-control').style.display = phrasesOn ? 'none' : 'flex';
    document.getElementById('phrase-controls').style.display = phrasesOn ? 'block' : 'none';
    var phraseButtons = document.querySelectorAll('#phrase-length-buttons button');
    for (var i = 0; i < phraseButtons.length; i++) {
        phraseButtons[i].classList.toggle('active', parseInt(phraseButtons[i].getAttribute('data-phrase-bars'), 10) === phraseLengthBars);
    }
    document.getElementById('phrase-shift-val').textContent = 'Bar ' + (phraseShiftBars + 1);

    // By phrase: four phrase colors. By bar: one color per bar of the phrase (2, 4 or 8 slots).
    var byBar = phraseColorMode === 'bar';
    document.getElementById('phrase-color-by-phrase').style.display = byBar ? 'none' : 'block';
    document.getElementById('phrase-color-by-bar').style.display = byBar ? 'block' : 'none';
    var phraseColorModeButtons = document.querySelectorAll('#phrase-color-mode-buttons button');
    for (var m = 0; m < phraseColorModeButtons.length; m++) {
        phraseColorModeButtons[m].classList.toggle('active', phraseColorModeButtons[m].getAttribute('data-phrase-color-mode') === phraseColorMode);
    }
    var barSlots = document.querySelectorAll('#phrase-color-by-bar [data-phrase-bar-slot]');
    for (var b = 0; b < barSlots.length; b++) {
        barSlots[b].style.display = parseInt(barSlots[b].getAttribute('data-phrase-bar-slot'), 10) < phraseLengthBars ? 'flex' : 'none';
    }
    document.getElementById('phrase-color-help').textContent = byBar
        ? 'Each bar of the phrase gets its own color; the sequence starts again with every phrase.'
        : 'All bars of a phrase share one color; the colors repeat every four phrases. To alternate two, repeat them (Red, Yellow, Red, Yellow).';
}

function getBeatsInBar(beatIndex) {
    // Map bars can be irregular (a 3-beat bar in a 4/4 song); grid bars always have beatsPerBar beats.
    return beatMapBarInfo ? beatMapBarInfo[beatIndex].len : beatsPerBar;
}

function buildMarkerLabel(beatIndex, firstBeatIndex, firstBarIndex) {
    // Bar numbers start at 1 on the first bar start found in the audio; earlier beats are a pickup.
    var positionInBar = getBeatPositionInBar(beatIndex, firstBeatIndex);
    var barNumber = getBarIndexForBeat(beatIndex, firstBeatIndex) - firstBarIndex + 1;
    var beatText = 'beat ' + (positionInBar + 1) + '/' + getBeatsInBar(beatIndex);
    if (positionInBar === 0) {
        var comment = 'Bar ' + barNumber + ', ' + beatText;
        if (markerColorMode === 'accent' && phraseLengthBars > 0) {
            var phraseIndex = getPhraseIndexForBeat(beatIndex, firstBeatIndex, firstBarIndex);
            var barInPhrase = getBarInPhraseForBeat(beatIndex, firstBeatIndex, firstBarIndex);
            comment += phraseIndex < 0 ? ', intro' : ', phrase ' + (phraseIndex + 1) + ' bar ' + (barInPhrase + 1) + '/' + phraseLengthBars;
        }
        return { n: 'Bar ' + barNumber, c: comment };
    }
    var isPickup = barNumber < 1 || (beatMapBarInfo && beatMapBarInfo[beatIndex].pickup);
    return { n: 'Beat', c: (isPickup ? 'Pickup' : 'Bar ' + barNumber) + ', ' + beatText };
}

function getPreviewRegionColor(colorIndex, alpha) {
    var rgb = PREMIERE_MARKER_PREVIEW_RGB[getPremiereMarkerColorIndex(colorIndex, 0)];
    return 'rgba(' + rgb + ', ' + alpha + ')';
}

function loadAudio(url, name) {
    document.getElementById('file-name').textContent = name || url;
    document.getElementById('status-msg').textContent = "Loading audio...";

    // Reset state
    allDetectedBeats = [];
    filteredBeats = [];
    filteredBeatColorIndexes = [];
    filteredBeatLabels = [];
    beatRegions = [];
    firstBeatRegion = null;
    audioBuffer = null;
    downbeatShift = 0; // The bar alignment belongs to each song.
    phraseShiftBars = 0; // So does the length of the intro.
    updateMeterControls();
    updatePhraseControls();
    // The beat map belongs to the audio; use the JSON saved next to this file, if any.
    currentAudioPath = isFileSystemPath(url) ? url : null;
    attachBeatMapForAudio();
    if (autoAnalyzeTimer) {
        clearTimeout(autoAnalyzeTimer);
        autoAnalyzeTimer = null;
    }
    wsRegions.clearRegions();
    document.getElementById('btn-create-markers').disabled = true;

    wavesurfer.load(toWaveSurferUrl(url));
}

// ============================================================================
// Beat map import (Rhythm Map / Beat This JSON)
// ============================================================================

function parseBeatMap(text, fileName) {
    // Accepts the Rhythm Map schema: beats[{time_s, downbeat}], optional rhythm_sections and duration_s.
    var json = JSON.parse(text);
    if (!json || Object.prototype.toString.call(json.beats) !== '[object Array]' || json.beats.length < 2) {
        throw new Error('The file has no "beats" list.');
    }
    var beats = [];
    var hasDownbeats = false;
    for (var i = 0; i < json.beats.length; i++) {
        var time = parseFloat(json.beats[i].time_s);
        if (isNaN(time) || time < 0) {
            continue;
        }
        var isDownbeat = json.beats[i].downbeat === true;
        hasDownbeats = hasDownbeats || isDownbeat;
        beats.push({ t: time, downbeat: isDownbeat });
    }
    beats.sort(function (a, b) { return a.t - b.t; });
    var sections = [];
    var rawSections = json.rhythm_sections || [];
    for (var k = 0; k < rawSections.length; k++) {
        var start = parseFloat(rawSections[k].start_s);
        var end = parseFloat(rawSections[k].end_s);
        if (isNaN(start) || isNaN(end) || end <= start) {
            continue;
        }
        sections.push({
            start: start,
            end: end,
            stability: parseFloat(rawSections[k].stability) || 0,
            beatCount: parseInt(rawSections[k].beat_count, 10) || 0
        });
    }
    return {
        fileName: fileName,
        beats: beats,
        hasDownbeats: hasDownbeats,
        sections: sections,
        durationS: parseFloat(json.duration_s) || null
    };
}

function loadBeatMapFromText(text, fileName) {
    try {
        beatMapData = parseBeatMap(text, fileName);
    } catch (error) {
        beatMapData = null;
        document.getElementById('map-file-name').textContent = 'No beat map loaded';
        document.getElementById('status-msg').textContent = 'Could not read the beat map: ' + error.message;
        updateBeatMapSummary();
        return false;
    }
    document.getElementById('map-file-name').textContent = fileName;

    // Start from the map's own bar length and no shift; the user can still change both.
    var fit = fitBeatMapGrid();
    if (window.detectionMode === 'map' && fit && (fit.barLength === 3 || fit.barLength === 4)) {
        beatsPerBar = fit.barLength;
        saveMeterSettings();
    }
    downbeatShift = 0;
    updateMeterControls();
    updateMarkerColorControls();
    updateBeatMapSummary();
    if (audioBuffer && window.detectionMode === 'map') {
        analyzeBeats();
    }
    return true;
}

function setupBeatMapControls() {
    document.getElementById('btn-load-map').addEventListener('click', function () {
        if (window.cep && window.cep.fs) {
            var result = window.cep.fs.showOpenDialog(false, false, 'Select Beat Map', null, ['json']);
            if (result.data && result.data.length > 0) {
                var path = result.data[0];
                var file = window.cep.fs.readFile(path);
                if (file.err) {
                    document.getElementById('status-msg').textContent = 'Could not open the beat map (error ' + file.err + ').';
                    return;
                }
                loadBeatMapFromText(file.data, path.split(/[\\/]/).pop());
            }
        } else {
            var input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json,application/json';
            input.onchange = function (e) {
                var selected = e.target.files[0];
                if (!selected) {
                    return;
                }
                var reader = new FileReader();
                reader.onload = function () { loadBeatMapFromText(reader.result, selected.name); };
                reader.readAsText(selected);
            };
            input.click();
        }
    });

    var sourceButtons = document.querySelectorAll('#map-source-buttons button');
    for (var i = 0; i < sourceButtons.length; i++) {
        sourceButtons[i].addEventListener('click', function () {
            beatMapSource = this.getAttribute('data-map-source');
            downbeatShift = 0; // The shift means something different in each source.
            saveMeterSettings();
            updateBeatMapSummary();
            if (audioBuffer && window.detectionMode === 'map') {
                analyzeBeats();
            }
        });
    }

    var skipBox = document.getElementById('map-skip-unstable');
    skipBox.checked = beatMapSkipUnstable;
    skipBox.addEventListener('change', function (e) {
        beatMapSkipUnstable = e.target.checked;
        saveMeterSettings();
        updateBeatMapSummary();
        if (audioBuffer && window.detectionMode === 'map') {
            analyzeBeats();
        }
    });
    updateBeatMapSummary();
}

function isBeatMapExactActive() {
    return window.detectionMode === 'map' && beatMapSource === 'exact' && !!beatMapData && beatMapData.hasDownbeats;
}

function getBeatMapExcludedRanges() {
    // Sections the map itself flags as unstable (e.g. a free-time intro or a fill read as double tempo).
    var ranges = [];
    if (!beatMapData || !beatMapSkipUnstable) {
        return ranges;
    }
    for (var i = 0; i < beatMapData.sections.length; i++) {
        var section = beatMapData.sections[i];
        if (section.stability < BEAT_MAP_STABILITY_THRESHOLD) {
            ranges.push(section);
        }
    }
    return ranges;
}

function isBeatTimeAllowed(time) {
    // Outside Beat Map mode every beat is allowed, exactly as before.
    if (window.detectionMode !== 'map') {
        return true;
    }
    var ranges = getBeatMapExcludedRanges();
    for (var i = 0; i < ranges.length; i++) {
        // A beat on a section boundary belongs to the section that starts there (5 ms tolerance).
        if (time >= ranges[i].start - 0.005 && time < ranges[i].end - 0.005) {
            return false;
        }
    }
    return true;
}

function fitBeatMapGrid() {
    // Least-squares tempo over the longest rhythm section, which avoids intros and endings.
    // The map's own BPM fields are not used: its times are rounded to 20 ms, which skews them.
    if (!beatMapData) {
        return null;
    }
    var beats = beatMapData.beats;
    var section = null;
    for (var s = 0; s < beatMapData.sections.length; s++) {
        var candidate = beatMapData.sections[s];
        if (candidate.stability > 0 && (!section || candidate.beatCount > section.beatCount)) {
            section = candidate;
        }
    }
    var indexes = [];
    for (var i = 0; i < beats.length; i++) {
        if (!section || (beats[i].t >= section.start - 0.005 && beats[i].t < section.end - 0.005)) {
            indexes.push(i);
        }
    }
    if (indexes.length < 8) {
        section = null;
        indexes = [];
        for (var all = 0; all < beats.length; all++) {
            indexes.push(all);
        }
    }

    var n = indexes.length;
    var meanIndex = 0;
    var meanTime = 0;
    for (var a = 0; a < n; a++) {
        meanIndex += indexes[a];
        meanTime += beats[indexes[a]].t;
    }
    meanIndex /= n;
    meanTime /= n;
    var covariance = 0;
    var variance = 0;
    for (var b = 0; b < n; b++) {
        covariance += (indexes[b] - meanIndex) * (beats[indexes[b]].t - meanTime);
        variance += (indexes[b] - meanIndex) * (indexes[b] - meanIndex);
    }
    var period = covariance / variance;
    var intercept = meanTime - period * meanIndex;
    var maxDeviation = 0;
    for (var c = 0; c < n; c++) {
        maxDeviation = Math.max(maxDeviation, Math.abs(beats[indexes[c]].t - (intercept + period * indexes[c])));
    }

    // Reference: first downbeat of the section (fitted time, not the rounded one); bar length: most common downbeat gap.
    var referenceIndex = indexes[0];
    var gapCounts = {};
    var previousDownbeat = -1;
    for (var d = 0; d < n; d++) {
        if (beats[indexes[d]].downbeat) {
            if (previousDownbeat < 0) {
                referenceIndex = indexes[d];
            } else {
                var gap = indexes[d] - previousDownbeat;
                gapCounts[gap] = (gapCounts[gap] || 0) + 1;
            }
            previousDownbeat = indexes[d];
        }
    }
    var barLength = null;
    var bestCount = 0;
    for (var key in gapCounts) {
        if (gapCounts[key] > bestCount) {
            bestCount = gapCounts[key];
            barLength = parseInt(key, 10);
        }
    }
    return {
        bpm: 60 / period,
        referenceTime: intercept + period * referenceIndex,
        maxDeviation: maxDeviation,
        start: section ? section.start : beats[0].t,
        end: section ? section.end : beats[beats.length - 1].t,
        beatCount: n,
        barLength: barLength
    };
}

function buildBeatMapBarInfo(beats) {
    // Bars from the map's downbeats. downbeatShift moves every downbeat flag that many beats later.
    // Downbeats in skipped sections are ignored; beats before the first downbeat of a run are a pickup.
    var count = beats.length;
    var fit = fitBeatMapGrid();
    var nominalLength = fit && fit.barLength ? fit.barLength : beatsPerBar;
    var allowed = [];
    var isDownbeat = [];
    for (var i = 0; i < count; i++) {
        allowed.push(isBeatTimeAllowed(beats[i].t));
    }
    for (var j = 0; j < count; j++) {
        var source = j - downbeatShift;
        isDownbeat.push(allowed[j] && source >= 0 && beats[source].downbeat);
    }

    var barNumberAt = [];
    var barCounter = -1;
    for (var k = 0; k < count; k++) {
        barNumberAt.push(isDownbeat[k] ? ++barCounter : null);
    }
    // Next downbeat (or end of the allowed run) after every index, scanning backwards.
    var nextBoundary = new Array(count);
    var nextDownbeatInRun = new Array(count);
    var boundary = count;
    var nextDownbeat = -1;
    for (var r = count - 1; r >= 0; r--) {
        if (!allowed[r]) {
            boundary = r;
            nextDownbeat = -1;
            nextBoundary[r] = r;
            nextDownbeatInRun[r] = -1;
            continue;
        }
        nextBoundary[r] = boundary;
        nextDownbeatInRun[r] = nextDownbeat;
        if (isDownbeat[r]) {
            boundary = r;
            nextDownbeat = r;
        }
    }

    var info = [];
    var lastDownbeat = -1;
    for (var x = 0; x < count; x++) {
        if (!allowed[x]) {
            lastDownbeat = -1;
            info.push({ pos: 0, bar: -1, len: nominalLength, pickup: true });
            continue;
        }
        if (isDownbeat[x]) {
            lastDownbeat = x;
        }
        if (lastDownbeat >= 0) {
            info.push({ pos: x - lastDownbeat, bar: barNumberAt[lastDownbeat], len: nextBoundary[lastDownbeat] - lastDownbeat, pickup: false });
        } else if (nextDownbeatInRun[x] >= 0) {
            var ahead = nextDownbeatInRun[x] - x;
            info.push({ pos: ((nominalLength - ahead) % nominalLength + nominalLength) % nominalLength, bar: barNumberAt[nextDownbeatInRun[x]] - 1, len: nominalLength, pickup: true });
        } else {
            info.push({ pos: 1, bar: -1, len: nominalLength, pickup: true }); // A run with no downbeat at all.
        }
    }
    return info;
}

function buildBeatMapBeats() {
    // Fills allDetectedBeats from the map. Returns false when there is no map to use.
    if (!beatMapData) {
        return false;
    }
    if (beatMapSource === 'grid' || !beatMapData.hasDownbeats) {
        var fit = fitBeatMapGrid();
        var duration = audioBuffer ? audioBuffer.duration : (beatMapData.durationS || fit.end);
        allDetectedBeats = generateBeatGrid(fit.referenceTime, fit.bpm, duration);
        beatMapReferenceTime = fit.referenceTime;
        beatMapBarInfo = null; // Bars follow the Time Signature and Downbeat Shift controls.
        return true;
    }
    allDetectedBeats = [];
    for (var i = 0; i < beatMapData.beats.length; i++) {
        allDetectedBeats.push(beatMapData.beats[i].t);
    }
    beatMapBarInfo = buildBeatMapBarInfo(beatMapData.beats);
    beatMapReferenceTime = null;
    for (var j = 0; j < beatMapBarInfo.length; j++) {
        if (beatMapBarInfo[j].pos === 0 && !beatMapBarInfo[j].pickup) {
            beatMapReferenceTime = allDetectedBeats[j];
            break;
        }
    }
    if (beatMapReferenceTime === null) {
        beatMapReferenceTime = allDetectedBeats[0];
    }
    return true;
}

function getBeatMapDurationWarning() {
    // The map's times are relative to the audio file it was made from; a different length means a different file.
    if (!beatMapData || !beatMapData.durationS || !audioBuffer) {
        return '';
    }
    if (Math.abs(audioBuffer.duration - beatMapData.durationS) > 0.5) {
        return 'Warning: the beat map is ' + beatMapData.durationS.toFixed(1) + 's long but the audio is ' +
            audioBuffer.duration.toFixed(1) + 's. Was it made from this file?';
    }
    return '';
}

function updateBeatMapSummary() {
    var summary = document.getElementById('map-summary');
    if (!summary) {
        return;
    }
    var sourceButtons = document.querySelectorAll('#map-source-buttons button');
    for (var i = 0; i < sourceButtons.length; i++) {
        sourceButtons[i].classList.toggle('active', sourceButtons[i].getAttribute('data-map-source') === beatMapSource);
    }
    if (!beatMapData) {
        summary.textContent = 'Load the JSON exported by Rhythm Map for this same audio file.';
        return;
    }
    var downbeats = 0;
    for (var b = 0; b < beatMapData.beats.length; b++) {
        if (beatMapData.beats[b].downbeat) downbeats++;
    }
    var fit = fitBeatMapGrid();
    var parts = [beatMapData.beats.length + ' beats, ' + downbeats + ' downbeats.'];
    parts.push('Steady tempo ' + fit.bpm.toFixed(2) + ' BPM from ' + fit.start.toFixed(2) + 's to ' + fit.end.toFixed(2) +
        's (grid within ' + Math.round(fit.maxDeviation * 1000) + ' ms' + (fit.barLength ? ', ' + fit.barLength + ' beats per bar' : '') + ').');
    var ranges = getBeatMapExcludedRanges();
    if (ranges.length) {
        // Merge back-to-back sections so the intro reads as one range.
        var merged = [];
        for (var r = 0; r < ranges.length; r++) {
            var lastRange = merged[merged.length - 1];
            if (lastRange && Math.abs(ranges[r].start - lastRange.end) < 0.01) {
                lastRange.end = ranges[r].end;
            } else {
                merged.push({ start: ranges[r].start, end: ranges[r].end });
            }
        }
        var rangeText = [];
        for (var m = 0; m < merged.length; m++) {
            rangeText.push(merged[m].start.toFixed(2) + '-' + merged[m].end.toFixed(2) + 's');
        }
        parts.push('Skipped as unstable: ' + rangeText.join(', ') + '.');
    }
    if (!beatMapData.hasDownbeats) {
        parts.push('No downbeats in this map: bars follow the Time Signature.');
    } else if (beatMapSource === 'exact') {
        parts.push('Bars come from the map; Downbeat Shift moves them by whole beats.');
    }
    var warning = getBeatMapDurationWarning();
    if (warning) {
        parts.push(warning);
    }
    summary.textContent = parts.join(' ');
}

// ============================================================================
// Run Rhythm Map (rhythm-map.exe) from the panel
// ============================================================================

function getNodeModules() {
    // CEP exposes Node through require() when the manifest enables it (--enable-nodejs).
    var nodeRequire = window.require || (window.cep_node && window.cep_node.require);
    if (!nodeRequire) {
        return null;
    }
    try {
        return {
            childProcess: nodeRequire('child_process'),
            fs: nodeRequire('fs'),
            path: nodeRequire('path'),
            os: nodeRequire('os'),
            Buffer: nodeRequire('buffer').Buffer
        };
    } catch (error) {
        return null;
    }
}

function isFileSystemPath(value) {
    return typeof value === 'string' && (/^[a-zA-Z]:[\\/]/.test(value) || value.indexOf('\\\\') === 0 || value.charAt(0) === '/');
}

function getBeatMapPathForAudio(audioPath) {
    // song.mp3 -> song.mp3.rhythm-map.json in the same folder (keeps video.mp4 and video.wav apart).
    var node = getNodeModules();
    var parsed = node.path.parse(audioPath);
    return node.path.join(parsed.dir, parsed.base + '.rhythm-map.json');
}

function attachBeatMapForAudio() {
    // Replaces any previous map: a map from another song would place markers in the wrong places.
    beatMapData = null;
    var node = getNodeModules();
    if (node && currentAudioPath) {
        var mapPath = getBeatMapPathForAudio(currentAudioPath);
        try {
            if (node.fs.existsSync(mapPath)) {
                loadBeatMapFromText(node.fs.readFileSync(mapPath, 'utf8'), node.path.basename(mapPath));
                updateRhythmMapControls();
                return;
            }
        } catch (error) {
            console.warn('Could not read the beat map next to the audio:', error);
        }
    }
    document.getElementById('map-file-name').textContent = 'No beat map loaded';
    updateBeatMapSummary();
    updateRhythmMapControls();
}

function restoreRhythmMapSettings() {
    try {
        var saved = JSON.parse(window.localStorage.getItem(RHYTHM_MAP_SETTINGS_STORAGE_KEY) || 'null');
        if (saved && saved.exePath) {
            rhythmMapExePath = saved.exePath;
            rhythmMapVersion = saved.version || '';
        }
    } catch (error) {
        console.warn('Unable to restore Rhythm Map settings:', error);
    }
}

function saveRhythmMapSettings() {
    try {
        window.localStorage.setItem(RHYTHM_MAP_SETTINGS_STORAGE_KEY, JSON.stringify({ exePath: rhythmMapExePath, version: rhythmMapVersion }));
    } catch (error) {
        console.warn('Unable to save Rhythm Map settings:', error);
    }
}

function updateRhythmMapControls() {
    var exeLabel = document.getElementById('rm-exe-name');
    if (!exeLabel) {
        return;
    }
    exeLabel.textContent = rhythmMapExePath ? (rhythmMapVersion ? rhythmMapVersion + ' - ' : '') + rhythmMapExePath : 'Not set';
    var running = !!rhythmMapChild;
    document.getElementById('btn-rm-analyze').disabled = running || !rhythmMapExePath || !currentAudioPath;
    document.getElementById('btn-rm-exe').disabled = running;
    document.getElementById('btn-rm-models').disabled = running;
    document.getElementById('btn-rm-cancel').style.display = running ? '' : 'none';
}

function setupRhythmMapControls() {
    restoreRhythmMapSettings();
    document.getElementById('btn-rm-exe').addEventListener('click', chooseRhythmMapExe);
    document.getElementById('btn-rm-analyze').addEventListener('click', function () { analyzeWithRhythmMap(); });
    document.getElementById('btn-rm-models').addEventListener('click', downloadRhythmMapModels);
    document.getElementById('btn-rm-cancel').addEventListener('click', function () {
        if (rhythmMapChild) {
            rhythmMapCancelled = true;
            rhythmMapChild.kill();
        }
    });
    updateRhythmMapControls();
}

function chooseRhythmMapExe() {
    var node = getNodeModules();
    if (!node) {
        document.getElementById('status-msg').textContent = 'Node.js is not available in this panel, so it cannot run Rhythm Map.';
        return;
    }
    if (!(window.cep && window.cep.fs)) {
        return;
    }
    // Windows builds are rhythm-map.exe; macOS builds have no extension, so no filter there.
    var isWindows = /^Win/.test(navigator.platform || '');
    var result = window.cep.fs.showOpenDialog(false, false, 'Select the rhythm-map executable', null, isWindows ? ['exe'] : null);
    if (result.data && result.data.length > 0) {
        validateRhythmMapExe(result.data[0]);
    }
}

function validateRhythmMapExe(exePath) {
    // Checks the build before trusting it: it must answer --help and accept --output.
    var node = getNodeModules();
    node.childProcess.execFile(exePath, ['--help'], { windowsHide: true, timeout: 15000 }, function (error, stdout, stderr) {
        var helpText = String(stdout || '') + String(stderr || '');
        if (error || helpText.indexOf('--output') < 0) {
            document.getElementById('status-msg').textContent = 'That program does not look like rhythm-map (no --output option): ' +
                (error ? error.message : helpText.slice(0, 120));
            return;
        }
        node.childProcess.execFile(exePath, ['--version'], { windowsHide: true, timeout: 15000 }, function (versionError, versionOut) {
            rhythmMapExePath = exePath;
            rhythmMapVersion = versionError ? '' : String(versionOut || '').trim();
            saveRhythmMapSettings();
            updateRhythmMapControls();
            document.getElementById('status-msg').textContent = 'Rhythm Map ready' + (rhythmMapVersion ? ': ' + rhythmMapVersion : '') + '.';
        });
    });
}

function runRhythmMap(args, label, onDone) {
    // Runs rhythm-map in the background with an elapsed-time counter; onDone(code, stdout, stderr, cancelled).
    var node = getNodeModules();
    var stdout = '';
    var stderr = '';
    var started = Date.now();
    rhythmMapCancelled = false;
    try {
        rhythmMapChild = node.childProcess.spawn(rhythmMapExePath, args, { windowsHide: true });
    } catch (error) {
        rhythmMapChild = null;
        onDone(-1, '', error.message, false);
        return;
    }
    updateRhythmMapControls();
    var statusEl = document.getElementById('status-msg');
    statusEl.textContent = label + '... 0 s';
    rhythmMapTimer = setInterval(function () {
        statusEl.textContent = label + '... ' + Math.round((Date.now() - started) / 1000) + ' s';
    }, 1000);
    rhythmMapChild.stdout.on('data', function (chunk) { stdout += chunk; });
    rhythmMapChild.stderr.on('data', function (chunk) { stderr += chunk; });
    var finished = false;
    function finish(code, message) {
        if (finished) return;
        finished = true;
        clearInterval(rhythmMapTimer);
        rhythmMapTimer = null;
        rhythmMapChild = null;
        updateRhythmMapControls();
        onDone(code, stdout, stderr + (message || ''), rhythmMapCancelled);
    }
    rhythmMapChild.on('error', function (error) { finish(-1, error.message); });
    rhythmMapChild.on('close', function (code) { finish(code); });
}

function describeRhythmMapError(stderr) {
    // Keeps Rhythm Map's own wording; only the last useful lines are shown.
    var lines = String(stderr || '').split(/\r?\n/).filter(function (line) { return line.trim(); });
    return lines.slice(-3).join(' ').slice(0, 400) || 'unknown error';
}

function analyzeWithRhythmMap(useWav) {
    var node = getNodeModules();
    var statusEl = document.getElementById('status-msg');
    if (!node || !rhythmMapExePath || !currentAudioPath) {
        statusEl.textContent = 'Rhythm Map needs the executable and an audio file on disk.';
        return;
    }
    var outputPath = getBeatMapPathForAudio(currentAudioPath);
    var extension = node.path.extname(currentAudioPath).toLowerCase();
    if (!useWav && RHYTHM_MAP_DIRECT_EXTENSIONS.indexOf(extension) < 0) {
        useWav = true;
    }

    function run(inputPath, cleanup) {
        runRhythmMap([inputPath, '--output', outputPath], 'Rhythm Map: analyzing' + (useWav ? ' (temporary WAV)' : ''), function (code, stdout, stderr, cancelled) {
            if (cleanup) cleanup();
            if (cancelled) {
                statusEl.textContent = 'Rhythm Map analysis cancelled.';
                return;
            }
            if (code === 0) {
                try {
                    loadBeatMapFromText(node.fs.readFileSync(outputPath, 'utf8'), node.path.basename(outputPath));
                    statusEl.textContent = 'Beat map saved next to the audio: ' + node.path.basename(outputPath);
                } catch (error) {
                    statusEl.textContent = 'Rhythm Map finished but its JSON could not be read: ' + error.message;
                }
                return;
            }
            if (/models fetch|model cache/i.test(stderr)) {
                document.getElementById('btn-rm-models').style.display = '';
                statusEl.textContent = 'Rhythm Map has no model pack yet. Click "Download models" (about 83 MB, once).';
                return;
            }
            if (/failed to write/i.test(stderr)) {
                statusEl.textContent = 'Rhythm Map could not write next to the audio (read-only folder?): ' + describeRhythmMapError(stderr);
                return;
            }
            if (!useWav) {
                // The original file could not be read: try again with a WAV decoded by the panel.
                analyzeWithRhythmMap(true);
                return;
            }
            statusEl.textContent = 'Rhythm Map failed: ' + describeRhythmMapError(stderr);
        });
    }

    if (!useWav) {
        run(currentAudioPath, null);
        return;
    }
    statusEl.textContent = 'Preparing a temporary WAV at full quality...';
    writeTemporaryWav(currentAudioPath).then(function (wavPath) {
        run(wavPath, function () {
            try { node.fs.unlinkSync(wavPath); } catch (error) { /* temporary file, nothing to do */ }
        });
    }).catch(function (error) {
        statusEl.textContent = 'Could not decode this file for Rhythm Map: ' + error.message;
    });
}

function writeTemporaryWav(audioPath) {
    // Decodes the original file again at 44.1 kHz: the waveform's own decode is 8 kHz (WaveSurfer default)
    // and would remove the high frequencies Beat This uses. Mono 16-bit PCM is enough for beat tracking.
    var node = getNodeModules();
    return new Promise(function (resolve, reject) {
        node.fs.readFile(audioPath, function (readError, fileBuffer) {
            if (readError) {
                reject(readError);
                return;
            }
            var arrayBuffer = fileBuffer.buffer.slice(fileBuffer.byteOffset, fileBuffer.byteOffset + fileBuffer.byteLength);
            var context = new OfflineAudioContext(1, 1, 44100);
            context.decodeAudioData(arrayBuffer).then(function (decoded) {
                var length = decoded.length;
                var channels = decoded.numberOfChannels;
                var pcm = node.Buffer.alloc(44 + length * 2);
                pcm.write('RIFF', 0);
                pcm.writeUInt32LE(36 + length * 2, 4);
                pcm.write('WAVEfmt ', 8);
                pcm.writeUInt32LE(16, 16);
                pcm.writeUInt16LE(1, 20);
                pcm.writeUInt16LE(1, 22);
                pcm.writeUInt32LE(decoded.sampleRate, 24);
                pcm.writeUInt32LE(decoded.sampleRate * 2, 28);
                pcm.writeUInt16LE(2, 32);
                pcm.writeUInt16LE(16, 34);
                pcm.write('data', 36);
                pcm.writeUInt32LE(length * 2, 40);
                var channelData = [];
                for (var c = 0; c < channels; c++) {
                    channelData.push(decoded.getChannelData(c));
                }
                for (var i = 0; i < length; i++) {
                    var sum = 0;
                    for (var ch = 0; ch < channels; ch++) {
                        sum += channelData[ch][i];
                    }
                    var sample = Math.max(-1, Math.min(1, sum / channels));
                    pcm.writeInt16LE(Math.round(sample * 32767), 44 + i * 2);
                }
                var wavPath = node.path.join(node.os.tmpdir(), 'beatdetector-' + Date.now() + '.wav');
                node.fs.writeFile(wavPath, pcm, function (writeError) {
                    if (writeError) reject(writeError); else resolve(wavPath);
                });
            }, reject);
        });
    });
}

function downloadRhythmMapModels() {
    var statusEl = document.getElementById('status-msg');
    runRhythmMap(['models', 'fetch'], 'Rhythm Map: downloading models', function (code, stdout, stderr, cancelled) {
        if (cancelled) {
            statusEl.textContent = 'Model download cancelled.';
            return;
        }
        if (code === 0) {
            document.getElementById('btn-rm-models').style.display = 'none';
            statusEl.textContent = 'Rhythm Map models installed. You can analyze now.';
        } else {
            statusEl.textContent = 'Model download failed: ' + describeRhythmMapError(stderr);
        }
    });
}

// ============================================================================
// Delete all markers of the selected clip (two clicks)
// ============================================================================

function setupDeleteClipMarkersButton() {
    var button = document.getElementById('btn-delete-clip-markers');
    var defaultLabel = button.textContent;
    var pendingCount = 0;

    function resetButton() {
        clearTimeout(deleteConfirmTimer);
        deleteConfirmTimer = null;
        pendingCount = 0;
        button.textContent = defaultLabel;
        button.classList.remove('is-confirming');
        button.disabled = false;
    }

    button.addEventListener('click', function () {
        var statusEl = document.getElementById('status-msg');
        if (!pendingCount) {
            // First click: count the selected clip's markers and ask for a second click.
            csInterface.evalScript('BeatDetector_getSelectedClipMarkerInfo()', function (response) {
                var info;
                try { info = JSON.parse(response); } catch (error) { info = { error: String(response) }; }
                if (info.error) {
                    statusEl.textContent = info.error;
                    return;
                }
                if (!info.count) {
                    statusEl.textContent = '"' + info.name + '" has no clip markers.';
                    return;
                }
                pendingCount = info.count;
                button.textContent = 'Click again to delete ' + info.count + ' markers from "' + info.name + '"';
                button.classList.add('is-confirming');
                statusEl.textContent = 'Clip markers belong to the source clip: every use of it in the project loses them.';
                deleteConfirmTimer = setTimeout(resetButton, 5000);
            });
            return;
        }

        // Second click: delete every marker in one call to Premiere (no batches, no progress counter).
        clearTimeout(deleteConfirmTimer);
        button.disabled = true;
        statusEl.textContent = 'Deleting ' + pendingCount + ' clip markers...';
        csInterface.evalScript('BeatDetector_deleteClipMarkerBatch(0)', function (response) {
            var result;
            try { result = JSON.parse(response); } catch (error) { result = { error: String(response) }; }
            if (result.error) {
                statusEl.textContent = 'Deleting markers failed: ' + result.error;
            } else if (result.remaining > 0) {
                statusEl.textContent = 'Deleted ' + result.deleted + ' clip markers; ' + result.remaining + ' could not be deleted.';
            } else {
                statusEl.textContent = 'Deleted ' + result.deleted + ' clip markers.';
            }
            resetButton();
        });
    });
}

function clearBeatPreview(message) {
    // Leave no stale markers behind when the active mode has nothing to show.
    allDetectedBeats = [];
    filteredBeats = [];
    filteredBeatColorIndexes = [];
    filteredBeatLabels = [];
    while (beatRegions.length) {
        beatRegions.pop().remove();
    }
    if (firstBeatRegion) {
        firstBeatRegion.remove();
        firstBeatRegion = null;
    }
    document.getElementById('btn-create-markers').disabled = true;
    document.getElementById('status-msg').textContent = message;
}

function analyzeBeats() {
    if (!audioBuffer) {
        document.getElementById('status-msg').textContent = "No audio loaded!";
        return;
    }

    document.getElementById('status-msg').textContent = "Analyzing...";

    var mode = window.detectionMode || 'manual';

    // Map data is only used in Beat Map mode.
    beatMapBarInfo = null;
    beatMapReferenceTime = null;

    // Keep the inexpensive manual grid synchronous so its preview follows the slider directly.
    function runAnalysis() {
        try {
            if (mode === 'map') {
                if (!buildBeatMapBeats()) {
                    clearBeatPreview('Beat Map mode: load a beat map (JSON) to place markers.');
                    updateMeterControls();
                    return;
                }
                updateMeterControls();
            } else if (mode === 'manual') {
                // Manual grid mode
                var manualBPM = parseInt(document.getElementById('bpm').value);
                var firstBeatOffset = parseFloat(document.getElementById('first-beat').value);
                var threshold = parseInt(document.getElementById('threshold').value) / 100;
                var minDistance = parseInt(document.getElementById('min-distance').value) / 1000;

                // Use the manual offset directly (no auto-detection)
                var firstBeat = firstBeatOffset;

                // Generate beat grid using manual BPM and first beat
                allDetectedBeats = generateBeatGrid(firstBeat, manualBPM, audioBuffer.duration);
                console.log("Manual Grid: First beat at " + firstBeat.toFixed(3) + "s, BPM: " + manualBPM + ", Total: " + allDetectedBeats.length + " beats");
            } else {
                // Algorithmic mode
                var threshold = parseInt(document.getElementById('threshold').value) / 100;
                var minDistance = parseInt(document.getElementById('min-distance').value) / 1000;
                allDetectedBeats = getImprovedBeats(audioBuffer, threshold, minDistance);
                console.log("Algorithmic: Detected " + allDetectedBeats.length + " beats");
            }

            updateFilteredBeats();
        } catch (e) {
            console.error(e);
            document.getElementById('status-msg').textContent = "Analysis failed: " + e.message;
        }
    }

    if (mode === 'manual') {
        runAnalysis();
    } else {
        // Let the panel repaint its status before the heavier automatic analysis starts.
        setTimeout(runAnalysis, 50);
    }
}

// Detect first beat and estimate tempo
function detectFirstBeatAndTempo(buffer, threshold, minDistance, updateUI) {
    var data = buffer.getChannelData(0);
    var sampleRate = buffer.sampleRate;
    var length = data.length;

    // Calculate onset strength
    var windowSize = 1024;
    var hopSize = 256;
    var onsetStrength = [];

    for (var i = windowSize; i < length - windowSize; i += hopSize) {
        var prevEnergy = 0;
        var currEnergy = 0;

        for (var j = 0; j < windowSize; j++) {
            prevEnergy += data[i - windowSize + j] * data[i - windowSize + j];
            currEnergy += data[i + j] * data[i + j];
        }

        var diff = Math.sqrt(currEnergy / windowSize) - Math.sqrt(prevEnergy / windowSize);
        onsetStrength.push({
            time: i / sampleRate,
            strength: Math.max(0, diff)
        });
    }

    // Find threshold
    var strengths = onsetStrength.map(function (o) { return o.strength; });
    strengths.sort(function (a, b) { return a - b; });
    var median = strengths[Math.floor(strengths.length / 2)];
    var mean = strengths.reduce(function (a, b) { return a + b; }, 0) / strengths.length;
    var variance = 0;
    for (var i = 0; i < strengths.length; i++) {
        variance += Math.pow(strengths[i] - mean, 2);
    }
    var stdDev = Math.sqrt(variance / strengths.length);
    var autoThreshold = median + (1.5 * stdDev);
    var finalThreshold = autoThreshold * (0.5 + threshold);

    // Find first strong beat
    var firstBeat = 0;
    for (var i = 2; i < onsetStrength.length - 2; i++) {
        var current = onsetStrength[i];
        var isLocalMax = current.strength > onsetStrength[i - 1].strength &&
            current.strength > onsetStrength[i - 2].strength &&
            current.strength > onsetStrength[i + 1].strength &&
            current.strength > onsetStrength[i + 2].strength;

        if (isLocalMax && current.strength > finalThreshold * 1.2) {
            firstBeat = current.time;
            break;
        }
    }

    // Estimate BPM using autocorrelation
    var tempo = estimateTempo(onsetStrength, sampleRate, { min: 60, max: 200 });

    console.log("Detected: First beat at " + firstBeat.toFixed(2) + "s, Tempo: " + tempo.toFixed(1) + " BPM");

    // Only update BPM slider if requested (for auto mode)
    if (updateUI) {
        document.getElementById('bpm').value = Math.round(tempo);
        document.getElementById('bpm-val').textContent = Math.round(tempo) + ' BPM';
    }

    return {
        firstBeat: firstBeat,
        tempo: tempo
    };
}

// Generate beat grid from first beat and BPM
function generateBeatGrid(firstBeat, bpm, duration) {
    var beatInterval = 60.0 / bpm;
    var beats = [];

    // Start from first beat and go forward
    var time = firstBeat;
    while (time < duration) {
        beats.push(time);
        time += beatInterval;
    }

    // Also go backward from first beat if needed
    time = firstBeat - beatInterval;
    while (time >= 0) {
        beats.unshift(time);
        time -= beatInterval;
    }

    return beats;
}

function scheduleManualGridPreview() {
    // Limit rapid range-input events to one grid refresh per painted frame.
    if (manualPreviewFrame !== null) {
        return;
    }

    manualPreviewFrame = requestAnimationFrame(function () {
        manualPreviewFrame = null;
        analyzeBeats();
    });
}

// Live preview for manual mode sliders
document.getElementById('bpm').addEventListener('input', function () {
    if (audioBuffer && window.detectionMode === 'manual') {
        scheduleManualGridPreview();
    }
});

document.getElementById('first-beat').addEventListener('input', function () {
    if (audioBuffer && window.detectionMode === 'manual') {
        scheduleManualGridPreview();
    }
});

// Live preview for algorithmic mode sliders
document.getElementById('threshold').addEventListener('input', function () {
    if (audioBuffer && window.detectionMode === 'auto') {
        analyzeBeats();
    }
});

document.getElementById('min-distance').addEventListener('input', function () {
    if (audioBuffer && window.detectionMode === 'auto') {
        analyzeBeats();
    }
});

// Filter existing beats by new threshold
function filterByThreshold(beats, threshold, minDistance) {
    // Re-analyze is needed for threshold changes
    // For now, just return existing beats
    return beats;
}

// Fully automatic beat detection with phase-locked loop
function getImprovedBeats(buffer, threshold, minDistance) {
    var data = buffer.getChannelData(0);
    var sampleRate = buffer.sampleRate;
    var length = data.length;

    console.log("Starting phase-locked beat detection...");

    // Step 1: Calculate onset strength function
    var windowSize = 1024;
    var hopSize = 256;
    var onsets = [];

    for (var i = 0; i < length - windowSize; i += hopSize) {
        var sum = 0;
        for (var j = 0; j < windowSize; j++) {
            var sample = data[i + j];
            sum += sample * sample;
        }
        var energy = Math.sqrt(sum / windowSize);
        onsets.push({
            time: i / sampleRate,
            energy: energy
        });
    }

    // Step 2: Calculate onset strength (first derivative)
    var onsetStrength = [];
    for (var i = 1; i < onsets.length; i++) {
        var diff = onsets[i].energy - onsets[i - 1].energy;
        onsetStrength.push({
            time: onsets[i].time,
            strength: Math.max(0, diff)
        });
    }

    // Step 3: Estimate tempo
    var tempo = estimateTempo(onsetStrength, sampleRate, { min: 60, max: 180 });
    var beatInterval = 60.0 / tempo;

    console.log("Detected tempo: " + tempo.toFixed(1) + " BPM");

    // Step 4: Calculate automatic threshold
    var strengths = onsetStrength.map(function (o) { return o.strength; });
    strengths.sort(function (a, b) { return a - b; });

    var median = strengths[Math.floor(strengths.length / 2)];
    var mean = strengths.reduce(function (a, b) { return a + b; }, 0) / strengths.length;

    var variance = 0;
    for (var i = 0; i < strengths.length; i++) {
        variance += Math.pow(strengths[i] - mean, 2);
    }
    var stdDev = Math.sqrt(variance / strengths.length);

    var autoThreshold = median + (1.5 * stdDev);
    var finalThreshold = autoThreshold * (0.5 + threshold);

    console.log("Auto threshold: " + autoThreshold.toFixed(4) + ", Final: " + finalThreshold.toFixed(4));

    // Step 5: Phase-locked loop beat tracking
    var peaks = [];
    var beatPhase = 0; // Current phase in the beat cycle (0 to 1)
    var lastBeatTime = -beatInterval;
    var phaseCorrection = 0;

    for (var i = 2; i < onsetStrength.length - 2; i++) {
        var current = onsetStrength[i];

        // Check if it's a local maximum
        var isLocalMax = current.strength > onsetStrength[i - 1].strength &&
            current.strength > onsetStrength[i - 2].strength &&
            current.strength > onsetStrength[i + 1].strength &&
            current.strength > onsetStrength[i + 2].strength;

        if (!isLocalMax || current.strength < finalThreshold) {
            continue;
        }

        var timeSinceLastBeat = current.time - lastBeatTime;

        // First few beats: establish the grid
        if (peaks.length < 4) {
            if (timeSinceLastBeat > minDistance) {
                peaks.push(current.time);
                lastBeatTime = current.time;
                beatPhase = 0;
            }
        } else {
            // Phase-locked loop: predict next beat time
            var predictedBeatTime = lastBeatTime + beatInterval;
            var timeError = current.time - predictedBeatTime;
            var phaseError = timeError / beatInterval;

            // Accept beat if within phase tolerance
            if (Math.abs(phaseError) < 0.25 && timeSinceLastBeat > minDistance * 0.7) {
                peaks.push(current.time);

                // Phase correction: adjust interval based on error
                beatInterval = beatInterval + (timeError * 0.1); // Gentle correction
                lastBeatTime = current.time;
                beatPhase = 0;
            }
            // If we've waited too long, insert a predicted beat
            else if (timeSinceLastBeat > beatInterval * 1.3) {
                // Insert predicted beat to maintain grid
                var predictedTime = lastBeatTime + beatInterval;
                peaks.push(predictedTime);
                lastBeatTime = predictedTime;
                beatPhase = 0;

                // Check if current onset could be the next beat
                if (current.time - predictedTime > beatInterval * 0.5 &&
                    current.time - predictedTime < beatInterval * 1.3) {
                    peaks.push(current.time);
                    lastBeatTime = current.time;
                }
            }
        }
    }

    // Step 6: Fill in any gaps with predicted beats
    var filledBeats = [];
    for (var i = 0; i < peaks.length - 1; i++) {
        filledBeats.push(peaks[i]);

        var gap = peaks[i + 1] - peaks[i];
        if (gap > beatInterval * 1.8) {
            // Fill gap with predicted beats
            var numMissing = Math.round(gap / beatInterval) - 1;
            for (var j = 1; j <= numMissing; j++) {
                filledBeats.push(peaks[i] + (beatInterval * j));
            }
        }
    }
    if (peaks.length > 0) {
        filledBeats.push(peaks[peaks.length - 1]);
    }

    console.log("Detected " + peaks.length + " beats, filled to " + filledBeats.length + " beats");
    return filledBeats;
}

// Improved tempo estimation with harmonic analysis and multi-octave detection
function estimateTempo(onsets, sampleRate, bpmRange) {
    var hopTime = 256 / sampleRate;
    var minLag = Math.floor((60.0 / bpmRange.max) / hopTime);
    var maxLag = Math.floor((60.0 / bpmRange.min) / hopTime);

    console.log("Tempo estimation: lag range " + minLag + " to " + maxLag);

    // Step 1: Calculate autocorrelation with energy weighting
    var correlations = [];

    for (var lag = minLag; lag < maxLag && lag < onsets.length / 3; lag++) {
        var score = 0;
        var count = 0;

        for (var i = 0; i < onsets.length - lag; i++) {
            // Weight by energy to emphasize strong beats
            var weight = onsets[i].strength * onsets[i + lag].strength;
            score += weight;
            count++;
        }

        if (count > 0) {
            score = score / count;
        }

        var bpm = 60.0 / (lag * hopTime);
        correlations.push({
            lag: lag,
            score: score,
            bpm: bpm
        });
    }

    // Step 2: Find peaks in correlation function
    var peaks = [];
    for (var i = 2; i < correlations.length - 2; i++) {
        var curr = correlations[i];
        // Check if it's a local maximum
        if (curr.score > correlations[i - 1].score &&
            curr.score > correlations[i - 2].score &&
            curr.score > correlations[i + 1].score &&
            curr.score > correlations[i + 2].score) {
            peaks.push(curr);
        }
    }

    // Sort peaks by score
    peaks.sort(function (a, b) { return b.score - a.score; });

    if (peaks.length === 0) {
        console.log("No peaks found, using fallback");
        return 120; // Fallback
    }

    console.log("Found " + peaks.length + " tempo peaks");

    // Step 3: Multi-octave analysis - check for half/double tempo errors
    var candidates = [];

    // Consider top 5 peaks
    for (var i = 0; i < Math.min(5, peaks.length); i++) {
        var peak = peaks[i];
        var bpm = peak.bpm;

        // Add this candidate
        candidates.push({
            bpm: bpm,
            score: peak.score,
            confidence: peak.score
        });

        // Also consider octave variations (half and double)
        if (bpm * 2 >= bpmRange.min && bpm * 2 <= bpmRange.max) {
            candidates.push({
                bpm: bpm * 2,
                score: peak.score * 0.8, // Slightly lower confidence
                confidence: peak.score * 0.8
            });
        }

        if (bpm / 2 >= bpmRange.min && bpm / 2 <= bpmRange.max) {
            candidates.push({
                bpm: bpm / 2,
                score: peak.score * 0.8,
                confidence: peak.score * 0.8
            });
        }
    }

    // Step 4: Score candidates based on musical plausibility
    for (var i = 0; i < candidates.length; i++) {
        var bpm = candidates[i].bpm;

        // Prefer tempos in common ranges
        var plausibilityBonus = 1.0;

        if (bpm >= 115 && bpm <= 145) {
            plausibilityBonus = 1.3; // Strong preference for 120-140 range
        } else if (bpm >= 80 && bpm <= 105) {
            plausibilityBonus = 1.2; // Good preference for 80-100 range
        } else if (bpm >= 145 && bpm <= 180) {
            plausibilityBonus = 1.15; // Moderate preference for fast tempos
        } else if (bpm >= 60 && bpm <= 80) {
            plausibilityBonus = 1.1; // Slight preference for slow tempos
        }

        candidates[i].confidence *= plausibilityBonus;
    }

    // Step 5: Find best candidate
    candidates.sort(function (a, b) { return b.confidence - a.confidence; });

    var bestTempo = candidates[0].bpm;

    console.log("Top 3 candidates:");
    for (var i = 0; i < Math.min(3, candidates.length); i++) {
        console.log("  " + candidates[i].bpm.toFixed(1) + " BPM (confidence: " + candidates[i].confidence.toFixed(4) + ")");
    }

    // Step 6: Refine using comb filtering
    var refinedTempo = refineTempoComb(onsets, bestTempo, hopTime);

    console.log("Final tempo: " + refinedTempo.toFixed(1) + " BPM (refined from " + bestTempo.toFixed(1) + ")");

    return refinedTempo;
}

// Refine tempo using comb filtering
function refineTempoComb(onsets, initialTempo, hopTime) {
    // Try small variations around the initial tempo
    var bestTempo = initialTempo;
    var bestScore = 0;

    // Search ±5% around initial tempo
    var minTempo = initialTempo * 0.95;
    var maxTempo = initialTempo * 1.05;
    var step = 0.1; // 0.1 BPM steps

    for (var tempo = minTempo; tempo <= maxTempo; tempo += step) {
        var beatInterval = 60.0 / tempo;
        var lagSamples = beatInterval / hopTime;

        // Calculate comb filter score
        var score = 0;
        var count = 0;

        // Check alignment at multiples of the beat interval
        for (var mult = 1; mult <= 8; mult++) {
            var lag = Math.round(lagSamples * mult);

            if (lag >= onsets.length) break;

            for (var i = 0; i < onsets.length - lag; i++) {
                score += onsets[i].strength * onsets[i + lag].strength;
                count++;
            }
        }

        if (count > 0) {
            score = score / count;
        }

        if (score > bestScore) {
            bestScore = score;
            bestTempo = tempo;
        }
    }

    return bestTempo;
}

function updateFilteredBeats() {
    if (allDetectedBeats.length === 0) return;

    // Find the generated beat that represents the user's first-beat offset (or the beat map's reference downbeat).
    var firstBeatOffset = beatMapReferenceTime !== null ? beatMapReferenceTime : parseFloat(document.getElementById('first-beat').value);
    var firstBeatIndex = 0;
    var smallestOffsetDifference = Infinity;
    for (var i = 0; i < allDetectedBeats.length; i++) {
        var offsetDifference = Math.abs(allDetectedBeats[i] - firstBeatOffset);
        if (offsetDifference < smallestOffsetDifference) {
            smallestOffsetDifference = offsetDifference;
            firstBeatIndex = i;
        }
    }

    // Bar numbering starts at the first bar start present in the audio.
    var firstBarIndex = 0;
    for (var b = 0; b < allDetectedBeats.length; b++) {
        if (getBeatPositionInBar(b, firstBeatIndex) === 0) {
            firstBarIndex = getBarIndexForBeat(b, firstBeatIndex);
            break;
        }
    }

    // Subdivision is anchored to the bar, so it never removes a bar start.
    // In 4/4 with no shift this keeps exactly the same beats as the original (j - firstBeatIndex) % subdivision test.
    filteredBeats = [];
    filteredBeatColorIndexes = [];
    filteredBeatLabels = [];
    var keptBeatIndexes = [];
    for (var j = 0; j < allDetectedBeats.length; j++) {
        var positionInBar = getBeatPositionInBar(j, firstBeatIndex);
        var keepBeat = (markerScope === 'bars' ? positionInBar === 0 : positionInBar % subdivision === 0) &&
            isBeatTimeAllowed(allDetectedBeats[j]);
        if (keepBeat) {
            filteredBeats.push(allDetectedBeats[j]);
            filteredBeatColorIndexes.push(getMarkerColorIndexForBeat(j, firstBeatIndex, firstBarIndex));
            filteredBeatLabels.push(buildMarkerLabel(j, firstBeatIndex, firstBarIndex));
            keptBeatIndexes.push(j);
        }
    }

    var statusText = "Detected " + filteredBeats.length + " markers (" + beatsPerBar + "/4, " +
        (markerScope === 'bars' ? "bar starts" : "/" + subdivision) +
        (downbeatShift ? ", shift +" + downbeatShift : "") + ")";
    if (window.detectionMode === 'auto') {
        statusText += ". Bars are approximate in Algorithmic mode: one missed beat shifts every later bar.";
    } else if (window.detectionMode === 'map') {
        statusText += ". Beat map: " + (beatMapSource === 'exact' ? "exact beats" : "fitted grid");
        var durationWarning = getBeatMapDurationWarning();
        if (durationWarning) {
            statusText += ". " + durationWarning;
        }
    }
    document.getElementById('status-msg').textContent = statusText;

    // The reference beat keeps its own region; it shows its marker color, or grey when the marks skip it.
    var firstBeatTime = allDetectedBeats[firstBeatIndex];
    var referenceKeptAt = keptBeatIndexes.indexOf(firstBeatIndex);
    var firstBeatOptions = {
        start: firstBeatTime,
        end: firstBeatTime + 0.05,
        color: referenceKeptAt >= 0 ? getPreviewRegionColor(filteredBeatColorIndexes[referenceKeptAt], 0.45) : 'rgba(150, 150, 150, 0.35)',
        drag: false,
        resize: false
    };
    if (firstBeatRegion) {
        firstBeatRegion.setOptions(firstBeatOptions);
    } else if (wsRegions) {
        firstBeatRegion = wsRegions.addRegion(firstBeatOptions);
    }

    // Update existing regions in place so the waveform never briefly loses all beat bars.
    var regionIndex = 0;
    for (var k = 0; k < filteredBeats.length; k++) {
        if (keptBeatIndexes[k] === firstBeatIndex) {
            continue;
        }
        var beatTime = filteredBeats[k];
        var regionOptions = {
            start: beatTime,
            end: beatTime + 0.05,
            color: getPreviewRegionColor(filteredBeatColorIndexes[k], 0.35),
            drag: false,
            resize: false
        };

        if (beatRegions[regionIndex]) {
            beatRegions[regionIndex].setOptions(regionOptions);
        } else if (wsRegions) {
            beatRegions[regionIndex] = wsRegions.addRegion(regionOptions);
        }
        regionIndex++;
    }

    // Remove only regions no longer needed after an audio duration or subdivision change.
    while (beatRegions.length > regionIndex) {
        beatRegions.pop().remove();
    }
    document.getElementById('btn-create-markers').disabled = false;
}

// Spectral Flux Beat Detection - much more accurate
function getEnergyPeaks(buffer, threshold, minDistance) {
    var data = buffer.getChannelData(0);
    var sampleRate = buffer.sampleRate;
    var length = data.length;
    var peaks = [];

    // Apply simple low-pass filter by averaging nearby samples
    var filteredData = new Float32Array(length);
    var filterSize = 5; // Average 5 samples (focuses on bass frequencies)

    for (var i = 0; i < length; i++) {
        var sum = 0;
        var count = 0;
        for (var j = Math.max(0, i - filterSize); j < Math.min(length, i + filterSize); j++) {
            sum += data[j];
            count++;
        }
        filteredData[i] = sum / count;
    }

    // Calculate energy envelope using RMS in sliding windows
    var windowSize = 2048; // ~46ms at 44.1kHz
    var hopSize = 512; // 75% overlap
    var energyHistory = [];

    for (var i = 0; i < length - windowSize; i += hopSize) {
        var sum = 0;
        for (var j = 0; j < windowSize; j++) {
            var sample = filteredData[i + j];
            sum += sample * sample;
        }
        var rms = Math.sqrt(sum / windowSize);
        energyHistory.push({
            time: i / sampleRate,
            energy: rms
        });
    }

    // Calculate spectral flux (energy difference between windows)
    var flux = [];
    for (var i = 1; i < energyHistory.length; i++) {
        var diff = energyHistory[i].energy - energyHistory[i - 1].energy;
        flux.push({
            time: energyHistory[i].time,
            flux: Math.max(0, diff) // Only positive changes (onsets)
        });
    }

    // Calculate adaptive threshold
    var fluxValues = flux.map(function (f) { return f.flux; });
    var meanFlux = fluxValues.reduce(function (a, b) { return a + b; }, 0) / fluxValues.length;
    var adaptiveThreshold = meanFlux * (1 + threshold * 2); // Scale with user threshold

    // Find peaks in flux that exceed adaptive threshold
    var lastPeakTime = -minDistance;

    for (var i = 1; i < flux.length - 1; i++) {
        var current = flux[i];
        var prev = flux[i - 1];
        var next = flux[i + 1];

        // Peak detection: current > neighbors and above threshold
        if (current.flux > prev.flux &&
            current.flux > next.flux &&
            current.flux > adaptiveThreshold) {

            if (current.time - lastPeakTime > minDistance) {
                peaks.push(current.time);
                lastPeakTime = current.time;
            }
        }
    }

    console.log("Spectral flux detection: " + peaks.length + " peaks, threshold: " + adaptiveThreshold.toFixed(4));
    return peaks;
}

// Fallback: Simple Peak Detection (faster but less accurate)
function getPeaks(buffer, threshold, minDistance) {
    var data = buffer.getChannelData(0);
    var peaks = [];
    var lastPeakTime = -minDistance;
    var sampleRate = buffer.sampleRate;
    var length = data.length;
    var step = 50;

    for (var i = 0; i < length; i += step) {
        var amplitude = Math.abs(data[i]);

        if (amplitude > threshold) {
            var time = i / sampleRate;
            if (time - lastPeakTime > minDistance) {
                peaks.push(time);
                lastPeakTime = time;
            }
        }
    }
    return peaks;
}

function updateMarkerCreationButton(isCreating, isStopping) {
    // Reflect the job state in the same action button without allowing duplicate create requests.
    var button = document.getElementById('btn-create-markers');
    button.textContent = isStopping ? 'Stopping...' : (isCreating ? 'Stop' : 'Create Markers');
    button.disabled = isStopping;
}

function finishMarkerCreation(message) {
    // Restore the panel after Premiere has completed, failed, or accepted a stop request.
    markerCreationJob = null;
    updateMarkerCreationButton(false, false);
    document.getElementById('status-msg').textContent = message;
}

function requestMarkerCreationStop() {
    // Stop after the active small batch returns so Premiere never leaves a partially executed script call.
    if (!markerCreationJob || markerCreationJob.cancelRequested) {
        return;
    }

    markerCreationJob.cancelRequested = true;
    updateMarkerCreationButton(true, true);
    document.getElementById('status-msg').textContent = 'Stopping marker creation...';
}

function cancelMarkerCreationInPremiere(job) {
    // Release the host-side job state once its active batch has returned to the CEP panel.
    csInterface.evalScript('BeatDetector_cancelMarkerCreation("' + job.id + '")', function () {
        finishMarkerCreation('Stopped after creating ' + job.created + ' of ' + job.total + ' markers.');
    });
}

function createNextMarkerBatch() {
    // Process one short host batch, then yield to CEP so the user can press Stop before the next batch.
    var job = markerCreationJob;
    if (!job) {
        return;
    }
    if (job.cancelRequested) {
        cancelMarkerCreationInPremiere(job);
        return;
    }

    var script = 'BeatDetector_addMarkerBatch("' + job.id + '", ' + MARKER_CREATION_BATCH_SIZE + ')';
    csInterface.evalScript(script, function (result) {
        // Ignore a late result from a job that was already replaced or finalized.
        if (markerCreationJob !== job) {
            return;
        }

        try {
            var response = JSON.parse(result);
            if (!response.success) {
                finishMarkerCreation('Error: ' + response.error);
                alert('Failed to create markers:\n\n' + response.error);
                return;
            }

            job.created += response.count || 0;
            job.failed += response.failed || 0;
            if (job.cancelRequested) {
                cancelMarkerCreationInPremiere(job);
                return;
            }
            if (response.complete) {
                var completionMessage = 'Created ' + job.created + ' markers!';
                if (job.failed > 0) {
                    completionMessage += ' (' + job.failed + ' failed.)';
                }
                finishMarkerCreation(completionMessage);
                return;
            }

            document.getElementById('status-msg').textContent =
                'Creating markers... ' + job.created + ' of ' + job.total;
            setTimeout(createNextMarkerBatch, 0);
        } catch (e) {
            console.error('Marker batch parse error:', e);
            finishMarkerCreation('Marker creation stopped: unexpected Premiere response.');
            alert('Response parse error while creating markers:\n\n' + result);
        }
    });
}

function createMarkersInPremiere() {
    // Turn the active action into Stop while a batch-based marker creation job is running.
    if (markerCreationJob) {
        requestMarkerCreationStop();
        return;
    }

    if (filteredBeats.length === 0) {
        alert("No beats detected! Please analyze audio first.");
        return;
    }

    document.getElementById('status-msg').textContent = "Preparing marker creation in Premiere...";
    document.getElementById('btn-create-markers').disabled = true;
    document.getElementById('btn-create-markers').textContent = 'Preparing...';

    var markerType = document.getElementById('marker-type').value;
    var offset = clipStartOffset; // Clip start minus its In point (see btn-load-active).

    // Sequence markers only cover the part of the media that the timeline clip actually plays.
    var markerBeats = [];
    var markerColors = [];
    var markerLabels = [];
    for (var beatIndex = 0; beatIndex < filteredBeats.length; beatIndex++) {
        var beatTime = filteredBeats[beatIndex];
        if (markerType === 'sequence' &&
            (beatTime < clipInPointSeconds - 0.0005 || (clipOutPointSeconds !== null && beatTime >= clipOutPointSeconds))) {
            continue;
        }
        markerBeats.push(beatTime);
        markerColors.push(filteredBeatColorIndexes[beatIndex]);
        markerLabels.push(filteredBeatLabels[beatIndex]);
    }
    if (markerBeats.length === 0) {
        finishMarkerCreation("No beats fall inside the selected clip.");
        return;
    }

    // Convert arrays to strings for passing to ExtendScript
    var beatsJson = JSON.stringify(markerBeats);
    var markerColorsJson = JSON.stringify(markerColors);
    var markerLabelsJson = JSON.stringify(markerLabels);

    // Debug info
    var debugInfo = "Creating markers:\n";
    debugInfo += "- Beats count: " + markerBeats.length + " (" + beatsPerBar + "/4, shift " + downbeatShift + ")\n";
    debugInfo += "- First 5 beats: " + markerBeats.slice(0, 5).join(", ") + "s\n";
    debugInfo += "- Last 5 beats: " + markerBeats.slice(-5).join(", ") + "s\n";
    debugInfo += "- Marker type: " + markerType + "\n";
    debugInfo += "- Offset: " + offset + "s\n";
    debugInfo += "- Marker colors: " + markerColorsJson;

    console.log(debugInfo);
    console.log("Beats JSON:", beatsJson.substring(0, 200));

    // Properly escape the JSON string for ExtendScript
    // We need to escape quotes and pass it as a string literal
    var escapedJson = beatsJson.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    var escapedMarkerColorsJson = markerColorsJson.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    var escapedMarkerLabelsJson = markerLabelsJson.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    var script = 'BeatDetector_beginMarkerCreation("' + escapedJson + '", "' + escapedMarkerColorsJson + '", ' + offset + ', "' + markerType + '", "' + escapedMarkerLabelsJson + '")';

    console.log("ExtendScript call:", script.substring(0, 200));

    csInterface.evalScript(script, function (result) {
        console.log("beginMarkerCreation result:", result);
        try {
            var res = JSON.parse(result);
            if (res.success) {
                markerCreationJob = {
                    id: res.jobId,
                    total: res.total,
                    created: 0,
                    failed: 0,
                    cancelRequested: false
                };
                updateMarkerCreationButton(true, false);
                createNextMarkerBatch();
            } else if (res.error) {
                finishMarkerCreation("Error: " + res.error);
                alert("Failed to create markers:\n\n" + res.error + "\n\n" + debugInfo);
            } else {
                finishMarkerCreation("Marker creation could not start");
                alert("Premiere returned an unexpected response while preparing markers.");
            }
        } catch (e) {
            console.error("Parse error:", e);
            alert("Response parse error!\n\nRaw response: " + result + "\n\nError: " + e.toString());
            finishMarkerCreation("Marker creation could not start");
        }
    });
}

function playClickTrack() {
    if (!audioBuffer || filteredBeats.length === 0) return;

    var btn = document.getElementById('btn-play-click');

    // Toggle play/pause
    if (wavesurfer.isPlaying()) {
        wavesurfer.pause();
        btn.textContent = '▶ Play Preview';
        return;
    }

    wavesurfer.play();
    btn.textContent = '⏸ Pause Preview';

    // Update button when playback finishes
    wavesurfer.on('finish', function () {
        btn.textContent = '▶ Play Preview';
    });
}
