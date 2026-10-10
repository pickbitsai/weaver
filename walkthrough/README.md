# Weaver author walkthrough generator

Generate a PowerPoint deck, slide PNGs, and a silent video from an installed Weaver book project. The book is read only; all generated files go to `--out`.

## Setup

Requires Node.js 22, the Claude Code CLI signed in to a subscription, headless Microsoft Edge at the standard Windows path, and `ffmpeg` plus `ffprobe` on `PATH`.

```powershell
cd walkthrough
npm install
cd ..
node walkthrough/bin/walkthrough.mjs --book C:\path\to\book --out C:\path\to\walkthrough-output --title "Book title" --author "Author name"
```

Audio uses the `none` provider by default; `--no-audio` selects the same provider explicitly. It makes no TTS request and reads no API key. A local TTS provider can be added to `lib/audio.mjs`. Silent slides stay on screen for at least six seconds and longer when needed to read the narration at about 150 words per minute. Add `--no-video` to omit MP4 creation or `--refresh` to regenerate cached explanations.

`inventory.json` records grouped files and hashes. `explanations.json` contains the five plain English descriptions for each entry. `slides.json` is the content source for the PowerPoint, HTML, frames, audio, and video. Failed Claude responses are marked `[needs review]` in the output README and slides.

Run `npm test` inside `walkthrough/` for its unit tests.

The package uses `pptxgenjs` as its only direct dependency. Its transitive `image-size` dependency is overridden to 2.0.4 because the version allowed by `pptxgenjs` has published denial-of-service advisories; the deck writer does not use its image parsing API.
