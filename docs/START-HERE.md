# Start here: your book with PickBits Weaver

Weaver keeps your book safe while an AI helps you with it. The AI reads, checks
and suggests changes to your prose. **You decide what goes into the book.**
Every decision you make is saved, and nothing is ever thrown away.

This guide is for you, the author. You don't need to know anything about code.
PickBits sets everything up with you on a screen share; this page is here so you
can follow along and look things up later.

## What you need

| You need | Windows | Mac |
| --- | --- | --- |
| **Node.js 22 or newer** (Weaver runs on it) | Go to [nodejs.org](https://nodejs.org), download the **LTS** version for Windows and run it. The standard choices are fine. | Go to [nodejs.org](https://nodejs.org), download the **LTS** version for macOS and run it. |
| **Git** (keeps your book's history) | Go to [git-scm.com/download/win](https://git-scm.com/download/win) and run the installer. The standard choices are fine. | Open Terminal and type `git --version`. If the Mac offers to install developer tools, click **Install**. |
| **Codex**, **Claude Code**, or both (your AI) | See below. | See below. |
| **A GitHub account** (for your backup) | Free, at [github.com](https://github.com). | Free, at [github.com](https://github.com). |

Your AI has to be one that can work in folders on your computer. The ordinary chat
windows (ChatGPT or Claude on the web) can't run Weaver.

- **Codex.** You can use Codex in the ChatGPT desktop app, as a *local* session in
  your book folder. Weaver also needs the Codex command-line tool, installed once,
  so it can check that Codex's safety checks are on and run whole-book checks on
  your ChatGPT plan. To install it, type this in a terminal:
  - **Windows** (in PowerShell):
    `powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"`
  - **Mac** (in Terminal): `curl -fsSL https://chatgpt.com/codex/install.sh | sh`

  If the installer asks whether to start Codex now, type `n` and press Enter. Then
  close the terminal, open a new one, type `codex login`, and sign in with your
  ChatGPT account in the browser window that opens.
- **Claude Code.** Claude Code needs a paid Claude plan (Pro or Max). To install it,
  type this in a terminal:
  - **Windows** (in PowerShell): `irm https://claude.ai/install.ps1 | iex`
  - **Mac** (in Terminal): `curl -fsSL https://claude.ai/install.sh | bash`

  Then close the terminal and open a new one. The first time you open Claude Code,
  it asks you to sign in with your Claude account.

**If you use only one of them, tell PickBits.** Weaver expects both unless your
book is set to one, and until then it can stop you approving chapters while it
waits for the other AI's safety checks.

After installing Node.js or Git, close any open terminal windows and open a new
one, so it can find them.

## Using a terminal

A few steps happen in a terminal: a window where you type a command and press
**Enter**. Type commands exactly as shown.

- **To open a terminal in a folder on Windows:** open the folder in File Explorer,
  right-click an empty space inside it, and choose **Open in Terminal**.
- **To open a terminal in a folder on a Mac:** open **Terminal** (in Applications,
  then Utilities), type `cd` followed by a space, drag the folder from Finder into
  the Terminal window, and press **Enter**.
- **On Windows, type `npx.cmd` wherever this guide says `npx`.** Windows sometimes
  blocks plain `npx`; `npx.cmd` always works.
- If the terminal ever asks *"Need to install the following packages: weaver ...
  Ok to proceed?"*, type `n` and press Enter. It means the terminal is not in your
  book folder.

## Where your book lives

Weaver lives in a folder called **Weaver** in your home folder (the folder with
your name on it). Your book gets its own folder inside it:

```text
Weaver                  the tool folder: Weaver itself lives here
  node_modules          Weaver's own files (leave these alone)
  package.json
  the-salt-road         your book folder
    manuscript          your chapters, one folder per chapter and scene
    world-bible         your notes on characters, places and words
    ...
```

- **Use a normal folder on your computer.** Never put the Weaver folder in
  OneDrive, Dropbox, iCloud Drive or Google Drive. They copy files while Weaver is
  saving your book's history, and that can damage the history. Your backup goes to
  GitHub instead (see below).
- **Watch out for Documents and Desktop.** On many Windows computers they live in
  OneDrive, and on many Macs they live in iCloud. That's why Weaver uses your home
  folder instead.
- **Keep the book folder inside the Weaver folder,** but not inside
  `node_modules`, which holds Weaver's own files: installing or updating Weaver
  replaces everything in it. Weaver's safety checks look for Weaver in the folders
  above your book.
- **On Windows, don't use `&` or `^` in folder names.** Windows tools that Weaver
  relies on can't handle them, so setup refuses those folders.
- **One book, one folder.** Don't copy the book folder to work on it somewhere
  else. If you ever need to move the folders, run setup again afterwards and redo
  the one-time steps.

## Setting up (PickBits does this with you)

Setup is one script: `setup-book.ps1` on Windows, `setup-book.sh` on a Mac.
PickBits gives you the script and the Weaver package to install. Open a terminal
in the folder where you saved the script, then type:

**Windows**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File setup-book.ps1 -Source <package> -Id the-salt-road -Title "The Salt Road"
```

**Mac**

```sh
sh setup-book.sh --source <package> --id the-salt-road --title "The Salt Road"
```

- `<package>` is the Weaver package from PickBits: a file ending in `.tgz`, an
  address on GitHub, or `@pickbitsai/weaver`.
- The **id** is a short name for your book: lowercase letters, numbers and hyphens,
  like `the-salt-road`. The **title** is your book's real title.

Setup then:

1. Checks that Node.js and Git are installed, and looks for Codex and Claude Code.
2. Creates the Weaver folder in your home folder and installs Weaver there.
3. Creates your book's folder inside it, or uses the book that is already there.
4. Turns on Weaver's safety checks for Claude Code and Codex, inside your book
   folder only. It never changes your AI's own settings.
5. Runs Weaver's health check and prints the steps still to do.

If something is missing, setup stops and tells you what to do in plain words.
Run setup yourself, in a terminal: your AI isn't allowed to run it, because setup
installs Weaver itself.

**Setup is safe to run again.** It never deletes your work, so running it again
later is a good way to check that everything is still in place. You don't need the
package file again: leave out `-Source` (Windows) or `--source` (Mac), and setup
keeps the Weaver that is installed. At the end, setup prints the exact command to
run it again on your computer. With the standard folders, it is:

**Windows**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$HOME\Weaver\node_modules\@pickbitsai\weaver\scripts\setup-book.ps1" -Id the-salt-road
```

**Mac**

```sh
sh ~/Weaver/node_modules/@pickbitsai/weaver/scripts/setup-book.sh --id the-salt-road
```

PickBits imports your finished manuscript into the new book after setup.

## One-time steps for each AI

Do these once, after setup. Setup lists the ones that are still left.

**Claude Code**

1. Open Claude Code in your book folder. (In a terminal opened in the book folder,
   type `claude` and press Enter.)
2. If it asks you to sign in, sign in with your Claude account in the browser
   window that opens.
3. When it asks whether you trust the folder, answer yes.
4. If Claude Code was already open there, close it and open it again, so it loads
   Weaver's checks.

**Codex**

1. Check that the Codex command-line tool is signed in: in a terminal, type
   `codex login status`. If it doesn't say you are logged in using ChatGPT, type
   `codex login` and sign in with your ChatGPT account.
2. Start a local Codex session in your book folder: one that runs on this
   computer, not a cloud task. Sign in with your ChatGPT account if it asks.
3. When Codex asks whether you trust the folder, say yes.
4. Type `/hooks`. Read each Weaver hook and trust it.
5. Close Codex and open it again, so it loads Weaver's rules.
6. On Windows, if Codex says it can't edit files, start it with
   `codex --sandbox workspace-write`, or choose **workspace-write** in Codex's
   permissions.

When Weaver is updated, Codex may ask you to review its hooks again. That's
expected: read them and trust them again.

To check that everything is on, look at the bottom of the author page: it should
say **Guardrails: on**.

## Turning on backup

Your backup is a private copy of your book and its whole history on GitHub.
PickBits does this with you the first time.

1. Sign in at [github.com](https://github.com).
2. Click **+** at the top right, then **New repository**.
3. Name it after your book, for example `the-salt-road`. Choose **Private**. Don't
   add a README or any other file.
4. Click **Create repository** and copy the address it shows, which looks like
   `https://github.com/your-name/the-salt-road.git`.
5. Open a terminal in your book folder and type (with your address):

```sh
npx weaver backup setup --remote https://github.com/your-name/the-salt-road.git
```

On Windows, type `npx.cmd` instead of `npx`. The first time, GitHub may ask you
to sign in.

## The daily loop

1. **Open your AI in your book folder.** Start Codex or Claude Code in that
   folder, as in the one-time steps.
2. **Ask it to check or fix a chapter.** For example:
   - "Check chapter 3 with Weaver and fix what it finds."
   - "Run a Weaver review of chapter 2 and tell me what it found."
   - "Check the whole book with Weaver." (This one takes a while.)

   The AI works on one chapter at a time. Weaver checks every edit as it happens
   and stops edits that would break your book's rules.
3. **Review on the author page.** Ask your AI to open the Weaver author page, or
   open a terminal in your book folder and type `npx weaver studio` (on Windows,
   `npx.cmd weaver studio`), then open
   [http://127.0.0.1:4187](http://127.0.0.1:4187) in your web browser. Keep that
   terminal open while you use the page. **Changes** shows your approved text and
   the AI's new text side by side.
4. **Accept, reject or undo.**
   - **Approve chapter** saves the chapter's changes in your book's history.
   - **Reject chapter** puts back the text you last approved. The rejected text is
     kept, not deleted.
   - Changed your mind? **Undo last approval** on **History** reverses your most
     recent approval.

Then move on to the next chapter. Only you can approve, reject, undo, rule on
findings and accept the story so far; Weaver doesn't let the AI do any of these.

## What never to do

- **Don't paste chapters into a chat window.** Text pasted into ChatGPT or Claude
  on the web has no history and no checks. Changes made there can't be reviewed or
  undone, and pasting them back over your chapters skips your approval.
- **Don't pass zip files of your book between AIs or computers.** Every copy
  starts its own history, and changes get lost or overwrite each other. Keep one
  book folder; your backup is the safe copy.
- **Don't ask the AI to fix, update or reinstall Weaver,** or to change its rules
  or settings so that a check passes. Weaver is built to refuse this. If Weaver
  seems wrong or broken, contact PickBits.
- **Don't keep the Weaver folder in OneDrive, Dropbox, iCloud Drive or Google
  Drive,** and don't move or rename the folders on your own.

## Getting help

Contact PickBits. It helps to send:

- what you were doing;
- the exact message you saw (copy and paste it, or take a screenshot);
- what the health check says: run setup again, or ask your AI to "run weaver
  doctor and show me the result".

Your work is safe while you wait. Every approval is saved in your book's history,
rejected text is kept, and undo never deletes anything.

## Words on the author page

| Word | What it means |
| --- | --- |
| **Author page** | Weaver's page in your web browser, where you read your book and make every decision. Its title says Weaver Studio. |
| **Home** | Your progress (how many chapters you have approved) and what is waiting for you. |
| **Book** | Read your book. Each chapter shows labels such as *approved*, *changes waiting*, *open findings* or *review out of date*. |
| **Scene, paragraph (¶)** | Chapters are made of scenes. Findings point to a scene and a paragraph: ¶3 is the third paragraph. |
| **Changes** | Edits the AI made that you haven't decided on yet. *Approved text* is what you last approved; *New text* is the AI's version. |
| **Approve chapter** | Accept a chapter's changes. Weaver saves them as an approval in your book's history. You approve one chapter at a time. |
| **Reject chapter** | Turn down a chapter's changes. The text you last approved comes back; the rejected text is kept. |
| **History** | Every approval, rejection and undo, with its date and note. |
| **Undo last approval** | Reverses your most recent approval. Nothing is deleted: the undo is recorded too. |
| **Finding** | Something Weaver or a reviewer noticed, such as a broken style rule, a line that doesn't sound like its speaker, or a continuity slip. |
| **Blocking / warning** | A blocking finding stops a chapter from being approved until it's fixed or you allow it. A warning is worth a look but stops nothing. |
| **Fix this / It's intended / Allow** | Your ruling on a finding. *Fix this* keeps it on the list to fix. *It's intended* (you meant it) and *Allow* (it's fine here) set it aside while that paragraph stays the same. If the paragraph changes, the finding comes back. |
| **Notes** | Smaller observations from a review. They don't need a decision. |
| **Review** | An AI read-through of a chapter for continuity, style and craft, plus any checks PickBits set up for your book. *Review out of date* means the chapter changed since its last review. |
| **Proposals** | Repairs the AI suggests for a chapter, shown before and after. *Accept selected* applies only the edits you tick and approves the chapter. *Reject* sets the proposal aside. *Ask again* asks for a new proposal, with your note if you add one. |
| **Dropped edits, declined findings** | Edits Weaver threw out (with the reason), and findings the AI chose not to change (with its reason). *No usable edits* means nothing usable came back: read the reasons, then *Ask again*. |
| **Rules** | Your book's style rules, for example how many dashes a paragraph may have. |
| **Characters, voice** | Who speaks in your book and how each one usually sounds. *Not enough evidence yet* means a character hasn't said enough to compare. |
| **Places, Threads, Facts timeline** | The places, open story threads and facts that Weaver's story-so-far records keep track of. |
| **Story so far (story state)** | A short record, scene by scene, of what the reader knows. When an earlier scene changes, the later records need a refresh. **Accept story state** is your confirmation that the records are right. |
| **Jobs** | Where longer work runs: **Run review** for one chapter, **Check whole book** for every chapter, and **Bootstrap state** to build story-so-far records for a book that has none yet. **AI host** picks Claude Code or Codex for the job. |
| **Doctor** | Weaver's health check. Its result is at the bottom of every page. |
| **Guardrails: on / off** | Weaver's safety checks inside your AI. *On* means the AI can't approve, change settings or rewrite your book's history. If it says *off*, run setup again or contact PickBits. |
| **Seal** | A fingerprint of your book's settings that PickBits makes at hand-over, so any later change to them shows up. |
| **Backup** | The private copy of your book and its history on GitHub. |
