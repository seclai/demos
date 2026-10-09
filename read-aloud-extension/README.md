<div align="center">
  <img alt="Read Aloud" src="./extension/icons/icon128.png" width="96">
  <h1>Read Aloud</h1>
  <p>Listen to any article, with each word highlighted as it's read. Powered by Seclai.</p>
</div>

A Chrome/Brave extension that turns the article you're reading into audio. Click
the toolbar icon, pick a voice, and a [Seclai](https://seclai.com) agent narrates
the page while the extension highlights the word being spoken and scrolls along
with it.

## Features

- **Reads the page you're on.** Article text is pulled straight from the page, so
  it works on sites that block bots or need a login.
- **Word-by-word highlighting.** The current word is highlighted, and you can click
  any word to jump there.
- **Music-player controls.** A scrubbable timeline, ±15 s, 0.5×–2× speed, and
  auto-scroll. Drag the player anywhere on the page.
- **Three voices with previews.** Nova and Shimmer (female) and Onyx (male).
- **Saved audio.** Generated audio is kept in the extension, so reopening an
  article plays instantly with no extra credits.
- **Download as MP3.**

## How it works

1. [content.js](extension/content.js) finds the article's main text on the page
   and splits it into parts of ~2,500 characters (the TTS model's input limit).
2. [background.js](extension/background.js) sends each part to the Seclai agent
   for the chosen voice. Two parts are generated at a time, and playback starts
   as soon as the first is ready. The API key stays in the service worker and is
   never exposed to the page.
3. Each agent is a single `generate_audio` step using OpenAI's `gpt-4o-mini-tts`
   (see [`agents/`](agents/)). The extension polls the run and downloads the MP3.
4. The TTS model returns no timestamps, so [align.js](extension/align.js) finds the
   pauses in the audio and matches sentence and paragraph ends to them across the
   whole part at once. Words in between are spread across the speech by length.
5. Highlighting uses the CSS Custom Highlight API, so the page's DOM is never
   modified.

## Prerequisites

- **Chrome, Brave, or another Chromium browser.**
- A **[Seclai](https://seclai.com) account** and an API key
  (**Account Settings → API Keys → Create**; it's shown once).

## Setup

1. Clone the repo.
2. Import the voice agents from [`agents/`](agents/) into Seclai
   (**Agents → Import**) and copy each agent's ID.
3. Open `chrome://extensions` (or `brave://extensions`), turn on **Developer
   mode**, click **Load unpacked**, and select the `extension/` folder.
4. Click the extension's toolbar icon. The Options page opens. Paste your API key
   and the three agent IDs, then click **Save**.
5. Open an article, click the icon, choose a voice, and click **Generate audio**.

## Cost

Narration is billed per output audio token: roughly **0.28 credits per
character**, or about 2,000 credits for a typical 7,000-character news article.
The player shows an estimate before you generate anything. Previews and
already-saved audio are free after the first time.

## Development

- No build step. Edit the files in `extension/`, then click reload on the
  extensions page and refresh the article tab.
- `node tools/align-test.cjs` (macOS) checks the word-timing accuracy. It
  synthesises sentences with the built-in `say` voices, joins them with known
  pauses, and reports how far the predicted sentence starts are from the truth.

## Known limitations

- Word timing within a sentence is estimated from word length. Sentence and
  paragraph starts are matched to the audio and are much more precise.
- Voice selection uses one agent per voice. A Seclai `switch` step ran every
  branch instead of only the matching one.
- ElevenLabs voices would be cheaper and better, but Seclai currently sends the
  voice label to ElevenLabs instead of a voice ID, so those requests fail.
