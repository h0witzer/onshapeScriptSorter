# Onshape Script Sorter (Chrome extension)

This extension runs on `https://cad.onshape.com/*` and does two things:

1. Opens an **organize dialog from the extension toolbar icon**.
2. Replaces the long flat list with a **cascading submenu** based on your saved folder tree.

It reads the currently available tools from the live Onshape DOM on each page load/open of the dropdown.

## Install (unpacked)

1. Open Chrome and go to `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder.

## Usage

- Open `cad.onshape.com`.
- Click the extension toolbar icon to open the organizer dialog.
- In the dialog:
  - Drag items to reorder.
  - Drop onto a folder to move inside it.
  - Create folders with **New Folder**.
  - Rename/delete folders.
  - Click **Save**.

Toolbar icon behavior:

- On `cad.onshape.com`: icon is green and enabled.
- On other sites: icon is gray, disabled, and tooltip is `only works on cad.onshape.com`.

Any newly discovered tools not yet in saved settings are automatically shown at the root.

## Storage

Settings are stored via the extension storage API (`chrome.storage.local`) under:

- `onshapeScriptSorter.tree.v1`
