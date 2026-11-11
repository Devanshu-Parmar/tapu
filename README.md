# Tapu

**A dynamic island for Windows.** *Tapu* (ટાપુ) is Gujarati for "island".

A small black bar hides at the top edge of your screen. Point at the top centre and it drops down; click it and it opens into music controls and a grid of tools. Everything stays one click away and out of sight the rest of the time.

Windows 10 (2004 or newer) and Windows 11. Free and open source under the MIT licence.

## What it does

**Live, in the bar**
- What is playing in any app (Spotify, YouTube, any player Windows knows about): cover, play/pause, skip, seek, volume, and time-synced lyrics
- Date, weather for your city, time, a second world clock
- Battery and charging, timers, reminders, processor and memory load
- Claude Code activity and today's token use, read from its local transcripts
- Notifications from Windows apps and from a paired phone, each as its own small pill, with a list behind the bell

**Tools**
- Screenshots: whole screen, an area, or draw on the screen first
- Screen recording
- Clipboard history, text and pictures
- Sticky notes with checklists, optional reminders and scribbles, docked on the screen edge or inside the island
- Voice dictation that types as you speak, fully offline (whisper.cpp); tap or hold `Ctrl+Alt+Space`
- Shelf: park files by dragging them onto the island, drag them out again later
- Quick Share: a temporary link that lets any device on your Wi-Fi download files from you or send files to you through its browser
- Phone link: send files and text to and from an Android phone (works with the LocalSend app), plus notifications, calls, replies and clipboard sync (works with the KDE Connect app)
- File tools: merge, split, rotate and compress PDFs; resize, convert and compress images; convert video and audio; zip and unzip; batch rename; remove image backgrounds; read text out of pictures (OCR)
- Unit and currency converter, translator, calendar with coloured day notes, world clocks, timer, colour picker, QR codes
- Ask AI: quick questions to Claude with your own Anthropic API key
- Password vault: a standard KeePass (KDBX 4) file that also opens in KeePassXC
- Wi-Fi, Bluetooth, night light, mute, keep-awake, lock
- Full-screen views: clock, music, battery, timer

**Settings**: colour (black, graphite, midnight, light), size, 12 or 24-hour clock, weather city and unit, which tools are shown, sounds, lyrics, notifications, clipboard history, start with Windows.

## Install

You need:
- [Node.js](https://nodejs.org) 20 or newer
- The [.NET 9 SDK](https://dotnet.microsoft.com/download/dotnet/9.0)

Then, in PowerShell:

```powershell
git clone https://github.com/Devanshu-Parmar/tapu.git
cd tapu
.\setup.ps1 -All
npm start
```

`setup.ps1` on its own builds the app. The switches fetch optional pieces from their own projects into a `vendor` folder:

| Switch | Fetches | Needed for | Size |
| --- | --- | --- | --- |
| `-Media` | FFmpeg | screen recording, video and audio tools, dictation | about 100 MB |
| `-Voice` | whisper.cpp and its `small` model (and FFmpeg) | dictation | about 470 MB |
| `-CutBg` | ISNet model | removing image backgrounds | about 170 MB |
| `-All` | all of the above | | |

If PowerShell refuses to run the script, start it with `powershell -ExecutionPolicy Bypass -File .\setup.ps1 -All`.

There is no one-click installer yet. To have Tapu start with Windows, switch that on in its Settings.

## Using it

| | |
| --- | --- |
| Show the bar | move the pointer to the top centre of the screen |
| Open | click the bar |
| Close | click anywhere else, or `Esc` |
| More tools | scroll over the tool grid |
| Hide or show Tapu | `Ctrl+Alt+I`, or click its icon beside the clock |
| Dictate | tap `Ctrl+Alt+Space`, speak, tap again; or hold it while speaking |
| Switch off | right-click the icon beside the clock, or `Ctrl+Alt+Q` |

Screenshots, recordings and received files are saved under `Downloads\Island`.

## Privacy

Tapu has no account, no telemetry and no server of its own. Your notes, clipboard history, settings and vault stay in `%APPDATA%\island` on your computer. It contacts the internet only for these, and only when the feature is used:

| Feature | Service | What is sent |
| --- | --- | --- |
| Weather | open-meteo.com | the coordinates of the city you chose |
| Finding a city | open-meteo.com | the name you typed |
| Lyrics | lrclib.net | song title, artist and length |
| Currency rates | open.er-api.com | nothing about you |
| Translate | mymemory.translated.net | the text you translate |
| Ask AI | api.anthropic.com | your question, with your own API key |

Phone link and Quick Share talk only to devices on your own network. Lyrics, notifications and clipboard history can each be switched off in Settings. The Ask AI key is stored encrypted with Windows' own protection (DPAPI).

## How it is built

- **Electron + React + TypeScript** for the island itself (`electron/`, `src/`). One see-through, always-on-top window; the main process tracks the pointer and makes the window click-through everywhere except the island's own shape.
- **A small .NET helper** (`helper/`) for the things only Windows APIs can do: media sessions, volume, OCR, typing dictated text, radios, night light, the notification centre. It talks to the app in JSON lines over stdin and stdout.
- It is written to stay out of the way: the helper reports only changes, nothing animates while the bar is hidden, and heavy libraries load on first use.

```powershell
npm run build     # build the island's page
npm run helper    # build the .NET helper
npm start         # run
npx tsc --noEmit  # type-check
```

## Good to know

- Dictation speed depends on your processor. Choosing your language instead of "Auto" in the Voice panel makes it start sooner.
- Windows has no official switch for night light; Tapu flips the same setting the Windows toggle does, and opens Windows Settings instead if the layout of that setting is not one it recognises.
- Windows app notifications need the notification access Windows asks about the first time.
- Quick Share here is Tapu's own link sharing. It is not Google's Quick Share protocol.
- The vault's master password cannot be recovered if you forget it.

## Credits

Tapu stands on [Electron](https://www.electronjs.org), [React](https://react.dev), [whisper.cpp](https://github.com/ggml-org/whisper.cpp), [FFmpeg](https://ffmpeg.org), [ONNX Runtime](https://onnxruntime.ai) with the ISNet model from [rembg](https://github.com/danielgatis/rembg), [pdf-lib](https://pdf-lib.js.org), [kdbxweb](https://github.com/keeweb/kdbxweb), the [Inter](https://rsms.me/inter/) typeface, and the open [LocalSend](https://localsend.org) and [KDE Connect](https://kdeconnect.kde.org) protocols. The idea comes from the dynamic island on Apple devices and from Mac apps built around it.

Spotify, YouTube and Claude marks belong to their owners and are shown only to label where sound or activity comes from. Tapu is not affiliated with any of them.

## Licence

[MIT](LICENSE)
