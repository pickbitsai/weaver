#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.

stop_setup() {
    printf '%s\n' '' "Setup stopped: $1" "What to do: $2"
    exit 1
}

usage() {
    printf '%s\n' 'Usage:
  sh setup-book.sh --source <package> --id <book-id> --title "<Book Title>" [--tool-folder <folder>] [--book-folder <folder>]

  --source       Where to get Weaver: a .tgz file, a GitHub release address, or @pickbitsai/weaver.
                 Can be left out when Weaver is already installed in the tool folder.
  --id           A new book'"'"'s id: lowercase letters, numbers and hyphens, like the-salt-road.
  --title        A new book'"'"'s title.
  --tool-folder  Where Weaver is installed. Default: a folder called Weaver in your home folder.
  --book-folder  The book'"'"'s folder, inside the tool folder. Default: the tool folder plus the id.
                 Give an existing book'"'"'s folder to keep using that book.

Setup is safe to run again. It never deletes your work and never changes your AI'"'"'s own settings.'
}

full_path() {
    SB_PATH_VALUE="$1"
    case "$SB_PATH_VALUE" in
        '~') SB_PATH_VALUE="$HOME" ;;
        '~/'*) SB_PATH_VALUE="$HOME/${SB_PATH_VALUE#\~/}" ;;
    esac
    "$SB_NODE" -e 'process.stdout.write(require("path").resolve(process.argv[1]))' "$SB_PATH_VALUE"
}

sync_provider() {
    SB_LOWER="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
    case "$SB_LOWER/" in
        */onedrive*) printf '%s\n' 'OneDrive' ;;
        */dropbox/*|*/'dropbox ('*')'/*) printf '%s\n' 'Dropbox' ;;
        */'icloud drive'/*|*/iclouddrive/*|*/library/'mobile documents'/*) printf '%s\n' 'iCloud Drive' ;;
        */'google drive'/*|*/googledrive/*|*/'my drive'/*) printf '%s\n' 'Google Drive' ;;
        */library/cloudstorage/*) printf '%s\n' 'a cloud storage folder' ;;
    esac
}

check_sync() {
    SB_PROVIDER="$(sync_provider "$2")"
    if [ -n "$SB_PROVIDER" ]; then
        stop_setup "The $1 folder is inside $SB_PROVIDER: $2" "$SB_PROVIDER copies files while Weaver saves your book's history, and that can damage the history. Choose a normal folder on this computer, for example $SB_EXAMPLE."
    fi
}

check_modules() {
    SB_LOWER="$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')"
    case "$SB_LOWER/" in
        */node_modules/*) stop_setup "The $1 folder is inside a node_modules folder: $2" "node_modules holds installed packages, and installing or updating Weaver replaces everything in it, so your book could be deleted. Choose a folder outside node_modules, for example $3." ;;
    esac
}

main() {
    SB_TOOL=''
    SB_BOOK=''
    SB_SOURCE=''
    SB_ID=''
    SB_TITLE=''
    SB_ID_GIVEN=false
    SB_TITLE_GIVEN=false
    SB_BOOK_GIVEN=false
    for SB_ARG in "$@"; do
        if [ "$SB_ARG" = '--help' ]; then usage; return 0; fi
    done
    while [ "$#" -gt 0 ]; do
        SB_OPTION="$1"
        case "$SB_OPTION" in
            --source=*|--id=*|--title=*|--tool-folder=*|--book-folder=*)
                SB_VALUE="${SB_OPTION#*=}"
                SB_OPTION="${SB_OPTION%%=*}"
                shift ;;
            --source|--id|--title|--tool-folder|--book-folder)
                if [ "$#" -lt 2 ]; then stop_setup "Setup needs a value after $SB_OPTION." 'Run setup with --help to see the options.'; fi
                SB_VALUE="$2"
                shift 2 ;;
            *) stop_setup "Setup does not understand \"$SB_OPTION\"." 'Check the spelling. Run setup with --help to see the options.' ;;
        esac
        case "$SB_OPTION" in
            --source) SB_SOURCE="$SB_VALUE" ;;
            --id) SB_ID="$SB_VALUE"; SB_ID_GIVEN=true ;;
            --title) SB_TITLE="$SB_VALUE"; SB_TITLE_GIVEN=true ;;
            --tool-folder) SB_TOOL="$SB_VALUE" ;;
            --book-folder) SB_BOOK="$SB_VALUE"; SB_BOOK_GIVEN=true ;;
        esac
    done
    if [ "${CLAUDECODE+x}" = x ] || [ "${CODEX_CI+x}" = x ] || [ "${CODEX_SESSION_ID+x}" = x ] || [ "${CODEX_THREAD_ID+x}" = x ]; then
        stop_setup 'Setup must be run by you in your own terminal, not by an AI.' 'Setup installs Weaver itself, and Weaver does not let the AI change its own tool. Open Terminal yourself and run setup there.'
    fi
    if [ "$SB_ID_GIVEN" = true ]; then
        case "$SB_ID" in
            ''|-*|*-|*--*|*[!abcdefghijklmnopqrstuvwxyz0123456789-]*)
                stop_setup "The book id \"$SB_ID\" can only use lowercase letters, numbers and hyphens." 'Use something like the-salt-road.' ;;
        esac
    fi
    case "$SB_ID" in
        con|prn|aux|nul|com[0-9]|lpt[0-9])
            stop_setup "The book id \"$SB_ID\" is a name Windows keeps for its own use." 'Choose another id, like the-salt-road.' ;;
    esac
    if [ "$SB_TITLE_GIVEN" = true ] && [ -z "$(printf '%s' "$SB_TITLE" | tr -d '[:space:]')" ]; then
        stop_setup 'The book title is empty.' "Add --title with your book's title."
    fi
    printf '%s\n' 'PickBits Weaver setup' '' 'Checking this computer...'
    SB_NODE_FIX='Install Node.js 22 or newer (choose the LTS version) from https://nodejs.org, then open a new Terminal window and run setup again.'
    SB_NODE="$(command -v node)"
    if [ -z "$SB_NODE" ]; then stop_setup 'Node.js is not installed on this computer.' "$SB_NODE_FIX"; fi
    SB_NODE_VERSION="$("$SB_NODE" --version)"
    SB_NODE_CODE="$?"
    SB_MAJOR="${SB_NODE_VERSION#v}"
    SB_MAJOR="${SB_MAJOR%%.*}"
    case "$SB_NODE_VERSION" in v[0-9]*.[0-9]*.[0-9]*|[0-9]*.[0-9]*.[0-9]*) ;; *) SB_NODE_CODE=1 ;; esac
    case "$SB_MAJOR" in ''|*[!0123456789]*) SB_NODE_CODE=1 ;; esac
    if [ "$SB_NODE_CODE" -ne 0 ] || [ "$SB_MAJOR" -lt 22 ]; then
        stop_setup "Node.js 22 or newer is needed, but this computer has Node.js $SB_NODE_VERSION." "$SB_NODE_FIX"
    fi
    SB_NPM_FIX='Reinstall Node.js 22 or newer from https://nodejs.org, then open a new Terminal window and run setup again.'
    SB_NPM="$(command -v npm)"
    if [ -z "$SB_NPM" ]; then stop_setup 'npm, which comes with Node.js, is missing or does not start.' "$SB_NPM_FIX"; fi
    SB_NPM_VERSION="$("$SB_NPM" --version)"
    if [ "$?" -ne 0 ]; then stop_setup 'npm, which comes with Node.js, is missing or does not start.' "$SB_NPM_FIX"; fi
    SB_SYSTEM="$(uname -s)"
    if [ "$SB_SYSTEM" = Darwin ]; then
        SB_GIT_FIX='Open Terminal and run  xcode-select --install  (or install Git from https://git-scm.com/download/mac), then run setup again.'
    else SB_GIT_FIX="Install Git with your system's package manager, then run setup again."
    fi
    SB_GIT="$(command -v git)"
    if [ -z "$SB_GIT" ]; then stop_setup 'Git is not installed or does not start.' "$SB_GIT_FIX"; fi
    SB_GIT_VERSION="$("$SB_GIT" --version)"
    if [ "$?" -ne 0 ]; then stop_setup 'Git is not installed or does not start.' "$SB_GIT_FIX"; fi
    SB_GIT_VERSION="${SB_GIT_VERSION#git version }"
    printf '%s\n' "Node.js $SB_NODE_VERSION, npm $SB_NPM_VERSION, Git $SB_GIT_VERSION: OK"
    SB_CODEX="$(command -v codex)"
    SB_CLAUDE="$(command -v claude)"
    if [ -n "$SB_CODEX" ] && [ -n "$SB_CLAUDE" ]; then printf '%s\n' 'Found: Codex and Claude Code'
    elif [ -n "$SB_CODEX" ]; then printf '%s\n' 'Found: Codex'
    elif [ -n "$SB_CLAUDE" ]; then printf '%s\n' 'Found: Claude Code'
    else
        printf '%s\n' 'Warning: neither Codex nor Claude Code was found on this computer.' "Setup will continue, but you need at least one of them to work on your book. At the end, setup shows where to find the author's guide, which explains how to get them."
    fi
    SB_HOME="$(full_path "$HOME")" || stop_setup 'The home folder could not be found.' 'Check HOME in your terminal, then run setup again.'
    SB_EXAMPLE="$SB_HOME/Weaver"
    SB_NEW_FIX='For a new book, add --id and --title (for example --id the-salt-road --title "The Salt Road"). For a book that already exists, add --book-folder with its folder.'
    if [ -z "$SB_TOOL" ]; then SB_TOOL="$SB_EXAMPLE"; fi
    SB_TOOL="$(full_path "$SB_TOOL")" || stop_setup 'The tool folder could not be read.' 'Choose a folder.'
    if [ -z "$SB_BOOK" ]; then
        if [ -z "$SB_ID" ]; then stop_setup 'Setup needs to know which book to use.' "$SB_NEW_FIX"; fi
        SB_BOOK="$SB_TOOL/$SB_ID"
    fi
    SB_BOOK="$(full_path "$SB_BOOK")" || stop_setup 'The book folder could not be read.' 'Choose a folder.'
    if [ "$SB_TOOL" = "$SB_HOME" ] || [ "$SB_TOOL" = / ]; then
        stop_setup "The tool folder cannot be your whole home folder or the top of a drive: $SB_TOOL" "Choose a folder inside it, for example $SB_EXAMPLE."
    fi
    if [ "$SB_BOOK" = "$SB_TOOL" ]; then
        stop_setup 'The book needs its own folder inside the tool folder.' "For example: $SB_TOOL/${SB_ID:-my-book}"
    fi
    case "$SB_BOOK" in
        "$SB_TOOL"/*) ;;
        *) stop_setup 'The book folder must be inside the tool folder.' "Weaver's safety checks look for Weaver in the folders above your book. Use a book folder inside $SB_TOOL, or choose a tool folder that contains $SB_BOOK." ;;
    esac
    check_modules tool "$SB_TOOL" "$SB_EXAMPLE"
    check_modules book "$SB_BOOK" "$SB_TOOL/${SB_ID:-my-book}"
    check_sync tool "$SB_TOOL"
    check_sync book "$SB_BOOK"
    if [ "$SB_SYSTEM" = Darwin ]; then
        case "$SB_BOOK" in "$SB_HOME/Documents/"*|"$SB_HOME/Desktop/"*)
            printf '%s\n' 'Warning: if iCloud keeps your Desktop and Documents in sync, choose a folder such as ~/Weaver instead.' ;;
        esac
    fi
    if [ -e "$SB_TOOL" ] && [ ! -d "$SB_TOOL" ]; then stop_setup "The tool folder is a file, not a folder: $SB_TOOL" 'Choose a folder.'; fi
    if [ -e "$SB_BOOK" ] && [ ! -d "$SB_BOOK" ]; then stop_setup "The book folder is a file, not a folder: $SB_BOOK" 'Choose a folder.'; fi
    SB_EXISTING=false
    if [ -f "$SB_BOOK/project.json" ]; then SB_EXISTING=true
    elif [ -d "$SB_BOOK" ]; then
        SB_ENTRIES="$(find "$SB_BOOK" -mindepth 1 -maxdepth 1 ! \( -type f \( -name .DS_Store -o -name desktop.ini -o -name Thumbs.db \) \))" || stop_setup "The book folder could not be read: $SB_BOOK" 'Choose a folder you can open, then run setup again.'
        if [ -n "$SB_ENTRIES" ]; then
            stop_setup "The book folder already has files in it, but it is not a Weaver book: $SB_BOOK" 'Choose a new or empty folder for the book. PickBits can bring in a finished manuscript after setup.'
        fi
    fi
    if [ "$SB_EXISTING" = false ] && { [ -z "$SB_ID" ] || [ -z "$SB_TITLE" ]; }; then
        stop_setup 'To create a new book, setup needs both an id and a title.' "$SB_NEW_FIX"
    fi
    if [ "$SB_EXISTING" = true ] && { [ "$SB_TITLE_GIVEN" = true ] || { [ "$SB_ID_GIVEN" = true ] && [ "$SB_BOOK_GIVEN" = true ]; }; }; then
        printf '%s\n' 'Note: this folder already holds a book, so the id and title you gave are not used.'
    fi
    SB_CLI="$SB_TOOL/node_modules/@pickbitsai/weaver/scripts/weaver.mjs"
    if [ -n "$SB_SOURCE" ]; then
        SB_CANDIDATE="$(full_path "$SB_SOURCE")" || stop_setup 'The package file name could not be read.' 'Check the file name and where you saved it, then run setup again.'
        if [ -f "$SB_CANDIDATE" ]; then SB_SOURCE="$SB_CANDIDATE"
        else
            case "$SB_SOURCE" in
                *://*|github:*|git+*) ;;
                *.tgz|*.tar.gz) stop_setup "Can't find the Weaver package file: $SB_SOURCE" 'Check the file name and where you saved it, then run setup again. To keep the Weaver that is already installed, leave out --source.' ;;
            esac
        fi
    elif [ ! -f "$SB_CLI" ]; then
        stop_setup 'Setup needs to know where to get Weaver.' 'Add --source with the package PickBits gave you: a .tgz file, a GitHub release address, or @pickbitsai/weaver.'
    fi
    printf '%s\n' "Tool folder: $SB_TOOL" "Book folder: $SB_BOOK"
    mkdir -p "$SB_TOOL" || stop_setup "The tool folder could not be created: $SB_TOOL" 'Choose a folder you can write to, then run setup again.'
    if [ ! -e "$SB_TOOL/package.json" ]; then
        printf '%s\n' '{' '  "name": "weaver-tool",' '  "private": true,' '  "description": "PickBits Weaver for the books in this folder. Created by setup-book."' '}' > "$SB_TOOL/package.json" || stop_setup 'The tool settings could not be saved.' 'Choose a folder you can write to, then run setup again.'
    fi
    if [ -z "$SB_SOURCE" ]; then printf '%s\n' 'Keeping the Weaver already installed in the tool folder.'
    else
        SB_PACKAGE="$SB_TOOL/node_modules/@pickbitsai/weaver"
        if [ -f "$SB_PACKAGE/scripts/integrity.mjs" ] && [ ! -L "$SB_PACKAGE" ]; then
            "$SB_NODE" "$SB_PACKAGE/scripts/integrity.mjs" --check >/dev/null 2>&1
            if [ "$?" -ne 0 ]; then
                printf '%s\n' "Weaver's own files in the tool folder were changed, so setup puts back the released files."
                rm -rf "$SB_PACKAGE"
            fi
        fi
        printf '%s\n' "Installing Weaver from $SB_SOURCE ..."
        (cd "$SB_TOOL" && "$SB_NPM" install --save-exact --no-audit --no-fund --no-update-notifier "$SB_SOURCE")
        if [ "$?" -ne 0 ]; then
            stop_setup "Weaver could not be installed from $SB_SOURCE." 'Check the internet connection and the package name or address, then run setup again. If it keeps failing, contact PickBits.'
        fi
    fi
    if [ "$SB_EXISTING" = true ] && [ ! -f "$SB_BOOK/project.json" ]; then
        stop_setup "The book's files disappeared from $SB_BOOK while Weaver was being installed." 'Contact PickBits before doing anything else. If you turned on backup, your book is safe on GitHub.'
    fi
    if [ ! -f "$SB_CLI" ]; then stop_setup 'Weaver was installed, but its files are not where setup expects them.' 'Contact PickBits.'; fi
    if [ ! -f "$SB_TOOL/node_modules/@pickbitsai/weaver/scripts/setup-guide.mjs" ]; then
        stop_setup "The Weaver in the tool folder is an older version that this setup script can't finish with." 'Run setup again with --source and the newest Weaver package from PickBits.'
    fi
    SB_VERSION="$("$SB_NODE" "$SB_CLI" version)"
    if [ "$?" -ne 0 ]; then stop_setup 'Weaver could not report its version.' 'Run setup again. If it keeps happening, contact PickBits.'; fi
    printf '%s\n' "Installed $SB_VERSION."
    if [ "$SB_EXISTING" = false ]; then
        rm -f "$SB_BOOK/.DS_Store" "$SB_BOOK/desktop.ini" "$SB_BOOK/Thumbs.db"
        "$SB_NODE" "$SB_CLI" init "$SB_BOOK" --id "$SB_ID" --title "$SB_TITLE" --empty
        if [ "$?" -ne 0 ]; then stop_setup 'Weaver could not create the book.' 'Read the message above, then run setup again. If it keeps failing, contact PickBits.'; fi
        printf '%s\n' "Created your book \"$SB_TITLE\" in $SB_BOOK."
    else printf '%s\n' "Using the book that is already in $SB_BOOK."
    fi
    printf '%s\n' "Installing Weaver's safety checks for Claude Code and Codex..."
    "$SB_NODE" "$SB_CLI" hooks install --host both --root "$SB_BOOK"
    SB_HOOKS_CODE="$?"
    if [ "$SB_HOOKS_CODE" -ne 0 ]; then printf '%s\n' 'Weaver could not finish installing its safety checks. The check below explains why.'; fi
    printf '%s\n' ''
    "$SB_NODE" "$SB_TOOL/node_modules/@pickbitsai/weaver/scripts/setup-guide.mjs" --root "$SB_BOOK" --tool "$SB_TOOL"
    SB_GUIDE_CODE="$?"
    if [ "$SB_HOOKS_CODE" -ne 0 ]; then return 1; fi
    return "$SB_GUIDE_CODE"
}

main "$@"; exit $?
