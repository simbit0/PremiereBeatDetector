# 🥁 Premiere Pro Beat Detector

A powerful Adobe Premiere Pro extension for automatic beat detection and marker placement in audio tracks.

---

# English

---

## ✨ Features

- **Automatic BPM Detection** - Advanced algorithm with multi-octave analysis and harmonic weighting
- **Three Detection Modes**:
  - **Manual Grid Mode** - Perfect beat grid based on BPM and first beat offset (recommended)
  - **Algorithmic Mode** - Phase-locked loop for complex rhythms (for experimentation)
  - **Beat Map Mode** - Uses a beat/downbeat map from [Rhythm Map](https://github.com/NagareWorks/rhythm-map) (optional external tool)
- **Time Signatures** - Group beats into 3/4 or 4/4 bars without changing the BPM, with a downbeat shift for pickups
- **Real-time Preview** - Visual beat markers on waveform with live updates
- **Precise Control** - Manual BPM adjustment and first beat offset with 1ms precision
- **Audio Playback** - Preview your audio with pause/resume functionality
- **Subdivision Support** - Create markers on every beat, every 2nd beat (/2) or every 4th beat (/4), always keeping bar starts
- **Bar Starts Only** - Mark only the first beat of each bar
- **Configurable Marker Colors** - One color, downbeat + other beats, or one color per beat of the bar
- **Phrase Colors** - Change the downbeat color every 2, 4 or 8 bars, by phrase or by bar inside the phrase
- **Named Markers** - Bar starts are named "Bar N"; comments give bar, beat and phrase
- **Flexible Marker Placement** - Choose between clip markers or sequence markers (sequence markers respect the clip's In point)
- **Delete All Clip Markers** - Clear the selected clip's markers from the panel (two-click confirmation)
- **Premiere Theme Support** - The panel follows Premiere Pro's light and dark interface colors

---

## 📋 Requirements

This extension is **self-contained** and requires no external dependencies!

| Requirement | Description |
|-------------|-------------|
| **Adobe Premiere Pro** | Version 2020 (14.0) or later |
| **Operating System** | Windows 10/11 or macOS 10.14+ |

> **No Python, Node.js, or other software installation required!** The extension uses built-in web technologies.
>
> Beat Map Mode can optionally run [Rhythm Map](https://github.com/NagareWorks/rhythm-map), which you build or install separately. Everything else works without it.

---

## 🚀 Installation

### macOS

#### Recommended installation
1. Open terminal and drag and drop `install-mac.sh` on it and launch it.

Or:
1. Open Terminal in the extension folder
2. Run:
```bash
./install-mac.sh
```
The installer enables debug mode automatically and installs Beat Detector for the current user, without administrator rights.

#### Step 2: Restart Premiere Pro
Go to **Window** > **Extensions** > **Beat Detector**

#### Manual installation only (if script cannot be used)
Enable debug mode in Terminal:
```bash
defaults write com.adobe.CSXS.11 PlayerDebugMode 1
defaults write com.adobe.CSXS.12 PlayerDebugMode 1
defaults write com.adobe.CSXS.13 PlayerDebugMode 1
```
Then copy the extension folder to the user extensions folder:
```
~/Library/Application Support/Adobe/CEP/extensions/
```

---

### Windows

#### Recommended installation
1. Open the extension folder
2. Run `install-windows.bat`
The installer enables debug mode automatically.
It installs Beat Detector for the current Windows user, without administrator rights.
It stays open and waits for a key press before closing.
Important: extract the ZIP first, do not run the installer directly from a compressed folder.

#### Step 2: Restart Premiere Pro
Go to **Window** > **Extensions** > **Beat Detector**

#### Manual installation only (if script cannot be used)
1. Press `Win + R`, type `regedit`, press Enter
2. Navigate to: `HKEY_CURRENT_USER\Software\Adobe\CSXS.11`
3. Right-click > New > String Value
4. Name: `PlayerDebugMode`
5. Double-click and set Value: `1`
6. Repeat for `CSXS.12` and `CSXS.13`
7. Copy the extension to:
```
C:\Program Files (x86)\Common Files\Adobe\CEP\extensions\com.antigravity.beatdetector
```
Or for user-only installation (no admin):
```
C:\Users\[YourUsername]\AppData\Roaming\Adobe\CEP\extensions\com.antigravity.beatdetector
```


## 📖 Usage

### Quick Start

1. **Load Audio**
   - Click "Load Active Sequence Audio" to load audio from a selected clip in your timeline
   - Or click "Select Audio File" to load any audio file

2. **Auto-Analysis**
   - The extension automatically detects BPM and analyzes beats when audio is loaded
   - BPM and first beat are detected and displayed

3. **Adjust Parameters** (Manual Grid Mode - Recommended)
   - **BPM**: Fine-tune the detected tempo (30-200 BPM; automatic detection searches 60-200)
   - **First Beat Offset**: Adjust where the beat grid starts (0-5 seconds)
   - Both sliders update the preview in real-time

4. **Preview**
   - Click "▶ Play Preview" to listen to your audio
   - Visual beat markers appear on the waveform in the colors the Premiere markers will have
   - Press **Spacebar** to play/pause

5. **Create Markers**
   - Choose marker type:
     - **Clip Markers (Source)**: Markers on the source clip
     - **Sequence Markers (Offset)**: Markers on the timeline
   - Click "Create Markers" to add beat markers to Premiere Pro
   - While markers are being created, click "Stop" to keep the markers already placed and cancel the remaining ones
   - **Delete All Clip Markers** removes every marker of the selected clip (including markers not created by the extension). Click once to see how many, click again within 5 seconds to delete. Clip markers belong to the source clip, so every use of that clip in the project loses them

6. **Time Signature and Bars**
   - **Time Signature**: 3/4 or 4/4. Beats are grouped into bars; the BPM is not changed
   - **Downbeat Shift** (-1 / +1): moves the bar start by whole beats without moving any beat, for pickups (anacrusis) or a wrongly detected first downbeat
   - **Marks**: *All beats* or *Bar starts only*
   - **Subdivision** is anchored to the bar, so it never removes a bar start. In 4/4 with no shift it keeps exactly the same beats as before

7. **Marker Colors** (limited to Premiere's 8 marker colors)
   - **One color**: every marker in the chosen color
   - **Downbeat**: one color for bar starts (Red by default) and one for the other beats (Green)
   - **Per beat**: one color for each beat position of the bar (3 slots in 3/4, 4 in 4/4)
   - **Phrases** (Downbeat mode): Off / 2 / 4 / 8 bars
     - *By phrase*: all bar starts of a phrase share a color; colors repeat every four phrases (Red, Yellow, Orange, Purple)
     - *By bar*: each bar of the phrase has its own color and the sequence restarts with every phrase
     - *Phrase 1 starts at*: number of intro bars before the first phrase
   - Bar start markers are named "Bar N"; comments read e.g. "Bar 9, beat 1/4, phrase 3 bar 1/4"

### Detection Modes

#### Manual Grid Mode (Recommended)
- Creates a perfect beat grid based on BPM and first beat
- No drift over time
- Best for music with consistent tempo
- Full manual control over BPM and timing

#### Algorithmic Mode
- Advanced phase-locked loop algorithm
- Adapts to tempo changes
- Best for complex or variable tempo music
- Adjustable threshold and minimum beat distance
- Bar accents are approximate here: one missed beat shifts every later bar

#### Beat Map Mode (optional, Rhythm Map)
Uses a JSON beat map produced by [Rhythm Map](https://github.com/NagareWorks/rhythm-map) (Beat This! neural beat and downbeat tracker) for the same audio file.
- **Rhythm Map program**: choose the `rhythm-map` executable once. The panel checks that it answers `--help` with an `--output` option and shows its version
- **Analyze with Rhythm Map**: analyzes the loaded audio and saves `<file>.rhythm-map.json` next to it (e.g. `song.mp3.rhythm-map.json`). Next time that audio is loaded, the map is used without re-analyzing
  - WAV, MP3, FLAC and OGG are analyzed directly; other files (MP4, MOV, M4A...), or files Rhythm Map cannot read, go through a temporary 44.1 kHz mono WAV that is deleted afterwards
  - **Download models** appears if Rhythm Map reports a missing model pack (`rhythm-map models fetch`, about 83 MB, once). **Cancel** stops a running analysis
- **Load Beat Map (JSON)**: use a map created outside the panel
- **Exact beats**: markers on the detected beats; bars come from the map's downbeats, including irregular bars. Time Signature is disabled; Downbeat Shift moves the downbeats by whole beats
- **Fitted grid**: a constant-tempo grid fitted by least squares to the longest steady section, aligned to its first downbeat. The map's own BPM fields are not used (its times are rounded to 20 ms)
- **Skip unstable sections**: no markers in sections whose stability is below 0.5 (e.g. a free-time intro)
- The panel summarizes the map (fitted tempo, skipped ranges) and warns when the map and the audio have different lengths

---

## 🐛 Troubleshooting

### Extension Not Visible
- Make sure PlayerDebugMode is enabled (see installation steps)
- Check that the extension folder is in the correct location
- Restart Premiere Pro completely
- Clear CEP cache (macOS): `rm -rf ~/Library/Caches/Adobe/CEP`

### No Audio Loaded
- Make sure you have a clip selected in the timeline
- The clip must have audio
- Try using "Select Audio File" to load a file directly

### Audio Loads But No Analysis
- If waveform/audio appears but analysis does not start, try **Select Audio File** with a local file path
- Avoid network/UNC paths when possible on older Premiere/CEP hosts
- Open Console (F12) and check for decode/CORS errors

### Markers Not Created
- Make sure you have analyzed the audio first
- For clip markers, ensure a clip is selected in the timeline
- Try using sequence markers instead

### Beat Map / Rhythm Map
- "Node.js is not available": the manifest must keep `--enable-nodejs` in its CEF command line
- Rhythm Map needs a release build (`cargo build --release -p rhythm-map-cli`); debug builds are much slower
- Errors from Rhythm Map are shown in the status line with its own message
- If the audio folder is read-only, the JSON cannot be saved next to the audio

### BPM Detection Issues
- The algorithm works best with clear, percussive music
- For complex music, try adjusting the Threshold slider in Algorithmic mode
- You can always manually adjust the BPM slider in Manual Grid mode

---

## 📝 Technical Details

- **Algorithm**: Multi-octave autocorrelation with harmonic weighting and comb filtering
- **Precision**: ±0.1 BPM tempo detection, 1ms offset precision
- **Frame Snapping**: Markers are automatically aligned to timeline frames
- **Audio Engine**: WaveSurfer.js for waveform visualization and playback (bundled locally, no internet required)
- **Supported Formats**: MP3, WAV, AIFF, and other browser-supported audio formats

---

## 📄 License

This extension is provided as-is for use with Adobe Premiere Pro.

**Version**: 1.2.4

---

## Changelog

### Unreleased — time signatures, phrase colors, Rhythm Map beat maps

- Time signature (3/4, 4/4), Downbeat Shift and "Bar starts only"; subdivision anchored to the bar.
- Marker colors: one color, downbeat + other beats, or per beat of the bar; phrase colors every 2, 4 or 8 bars (by phrase or by bar).
- Bar start markers named "Bar N"; marker comments give bar, beat and phrase.
- Beat Map mode: import a Rhythm Map JSON (exact beats or fitted grid, unstable sections skipped), or run Rhythm Map from the panel.
- Delete All Clip Markers button with two-click confirmation.
- Fix: sequence markers now subtract the clip's In point and skip beats outside the clip.
- Fix: subdivision buttons no longer clear the Detection Mode highlight.
- Manual BPM slider starts at 30 BPM.

### 1.2.4 — 2026-10-22

- Markers can now use a configurable color pattern by beat, or a single chosen color.
- Marker creation can be stopped while keeping the markers already placed.
- Your marker color preferences are remembered across Premiere projects.

### 1.2.0 — 2026-10-15

- The Manual Grid preview is now stable while adjusting BPM or the first beat: `/2` and `/4` always keep the selected first beat visible, with smoother marker updates.
- The panel now follows Premiere Pro's light and dark themes, and its version badge opens the Beat Detector page.
- Improved audio loading and automatic analysis reliability in CEP hosts, including Premiere Pro 2024 on Windows.
- Simplified installation on macOS and Windows: both installers work in the current user account without administrator rights and provide clearer feedback.

### 1.1.3 — 2026-02-06

- Added an automatic update notification with a direct download link and a localized update banner.
- Fixed macOS installer permission issues.

### 1.1.2 — 2026-01-20

- Added `BeatDetector_` prefixes to ExtendScript functions to prevent conflicts with other Premiere extensions.

### 1.1.1 — 2026-01-14

- Improved the bilingual README and added macOS and Windows installer scripts.
- Corrected the Windows debug-mode registry instructions.

### 1.1.0 — 2025-12-19

- First public release of Premiere Pro Beat Detector.
