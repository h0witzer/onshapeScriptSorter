(() => {
  const STORAGE_KEY = "onshapeScriptSorter.tree.v1";
  // Onshape's dark mode sets this color (#333333) as the body background.
  const ONSHAPE_DARK_BG = "rgb(51, 51, 51)";
  // Gap in pixels between the submenu edge and the viewport boundary.
  const SUBMENU_VIEWPORT_MARGIN = 8;

  const state = {
    lastSignature: "",
    currentTools: new Map(),
    observer: null,
    rerenderTimer: null
  };

  let currentMenuClickListener = null;

  async function getStoredTree() {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      try {
        const result = await chrome.storage.local.get(STORAGE_KEY);
        const parsed = result?.[STORAGE_KEY];
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }

    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  async function saveTree(tree) {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      try {
        await chrome.storage.local.set({ [STORAGE_KEY]: tree });
        return;
      } catch {
        // Fall through to localStorage fallback.
      }
    }

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(tree));
  }

  function getNextFolderId() {
    return `folder_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function scanCurrentTools(dropdownContent) {
    const map = new Map();

    const allToolEls = dropdownContent.querySelectorAll(
      ".tool.is-activatable.is-button[data-bs-original-title][context-menu-details]"
    );

    allToolEls.forEach((el) => {
      const title = (el.getAttribute("data-bs-original-title") || "").trim();
      if (!title) return;

      const commandId = el.getAttribute("command-id") || "";
      const details = el.getAttribute("context-menu-details") || "";
      // Skip action buttons (Sort custom features, Update all, etc.) that carry an
      // empty context-menu-details attribute — only actual custom-feature scripts have
      // a meaningful value here.
      if (!details) return;
      const dataId = el.getAttribute("data-id") || "";
      const id = details || `${commandId}::${title}::${dataId}`;

      // Keep the first matching clickable element for this tool key.
      if (!map.has(id)) {
        map.set(id, { id, title, commandId, details, dataId, el });
      }
    });

    return map;
  }

  function listSavedToolIds(nodes, out = new Set()) {
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      if (node.type === "tool" && node.id) out.add(node.id);
      if (node.type === "folder" && Array.isArray(node.children)) {
        listSavedToolIds(node.children, out);
      }
    }
    return out;
  }

  function filterTreeToCurrentTools(nodes, currentTools) {
    const result = [];
    for (const node of nodes || []) {
      if (!node || typeof node !== "object") continue;
      if (node.type === "tool") {
        if (currentTools.has(node.id)) result.push({ type: "tool", id: node.id });
      } else if (node.type === "folder") {
        const children = filterTreeToCurrentTools(node.children || [], currentTools);
        result.push({
          type: "folder",
          id: node.id || getNextFolderId(),
          name: node.name || "Folder",
          children
        });
      }
    }
    return result;
  }

  function makeEffectiveTree(savedTree, currentTools) {
    const base = filterTreeToCurrentTools(savedTree, currentTools);
    const savedIds = listSavedToolIds(base);

    for (const [id] of currentTools.entries()) {
      if (!savedIds.has(id)) {
        base.push({ type: "tool", id });
      }
    }

    return base;
  }

  function isOnshapeDarkMode() {
    // Onshape's dark mode applies #333333 (rgb(51,51,51)) as the body background.
    return getComputedStyle(document.body).backgroundColor === ONSHAPE_DARK_BG;
  }

  function buildMenu(dropdownContent, effectiveTree, currentTools) {
    // Restore any previously moved tool elements back to the dropdown so they are
    // available for re-ordering and so Onshape can manage their lifecycle normally.
    // Guard with isConnected in case Onshape already removed the element from the DOM.
    dropdownContent.querySelectorAll(".osss-moved-tool").forEach((el) => {
      el.classList.remove("osss-moved-tool");
      if (el.isConnected) {
        dropdownContent.appendChild(el);
      }
    });

    // Remove previous custom UI if any.
    dropdownContent.querySelectorAll(".osss-menu-root").forEach((n) => n.remove());

    const menuRoot = document.createElement("div");
    menuRoot.className = "osss-menu-root";
    menuRoot.classList.toggle("osss-dark", isOnshapeDarkMode());

    const createToolVisual = (tool, fallbackTitle) => {
      const frag = document.createDocumentFragment();

      const icon = tool?.el?.querySelector?.(".tool-icon");
      if (icon) {
        frag.appendChild(icon.cloneNode(true));
      }

      const label = document.createElement("span");
      label.className = "tool-label";
      label.textContent = fallbackTitle || tool?.title || "";
      frag.appendChild(label);

      return frag;
    };

    const chooseSubmenuDirection = (folderEl, submenuEl) => {
      const folderRect = folderEl.getBoundingClientRect();

      // Temporarily show to measure the submenu dimensions.
      submenuEl.style.visibility = "hidden";
      submenuEl.style.display = "block";
      const submenuRect = submenuEl.getBoundingClientRect();
      const submenuWidth = submenuRect.width || 230;
      const submenuHeight = submenuRect.height || 0;
      submenuEl.style.display = "";
      submenuEl.style.visibility = "";

      const spaceRight = window.innerWidth - folderRect.right;
      const spaceLeft = folderRect.left;

      // Align submenu top with the folder row, but clamp so it doesn't overflow below the viewport.
      const rawTop = folderRect.top;
      const maxTop = window.innerHeight - submenuHeight - SUBMENU_VIEWPORT_MARGIN;
      submenuEl.style.top = Math.max(0, Math.min(rawTop, maxTop)) + "px";

      if (spaceRight < submenuWidth && spaceLeft > spaceRight) {
        submenuEl.style.left = "auto";
        submenuEl.style.right = (window.innerWidth - folderRect.left) + "px";
      } else {
        submenuEl.style.left = folderRect.right + "px";
        submenuEl.style.right = "auto";
      }
    };

    const renderNodes = (nodes, container) => {
      for (const node of nodes) {
        if (node.type === "tool") {
          const tool = currentTools.get(node.id);
          if (!tool) continue;

          // Move the real Onshape element into our folder structure so that all
          // native event handlers (click, contextmenu, keyboard, etc.) remain
          // connected and behave exactly as Onshape intended.
          tool.el.classList.add("osss-moved-tool");
          container.appendChild(tool.el);
        } else if (node.type === "folder") {
          const folder = document.createElement("div");
          folder.className = "tool is-activatable is-button osss-menu-item osss-folder";
          folder.appendChild(createToolVisual(null, node.name || "Folder"));

          const submenu = document.createElement("div");
          submenu.className = "osss-submenu";
          renderNodes(node.children || [], submenu);
          folder.appendChild(submenu);

          folder.addEventListener("click", (e) => {
            e.stopPropagation();
            const isOpen = folder.classList.contains("osss-open");
            // Close any sibling folders that are currently open.
            Array.from(container.children).forEach((child) => {
              if (child !== folder) child.classList.remove("osss-open");
            });
            if (isOpen) {
              folder.classList.remove("osss-open");
            } else {
              chooseSubmenuDirection(folder, submenu);
              folder.classList.add("osss-open");
            }
          });

          container.appendChild(folder);
        }
      }
    };

    renderNodes(effectiveTree, menuRoot);

    // Prevent right-click (contextmenu) events originating from a moved tool element
    // from bubbling up to Onshape's dropdown dismissal logic.  The event still fires
    // on the real tool.el first (showing Onshape's native Update/Remove/… context
    // menu) before being caught here and stopped.  We only stop propagation when the
    // event came from a tool — right-clicks on folder rows or empty areas are left to
    // bubble normally.
    menuRoot.addEventListener("contextmenu", (e) => {
      if (e.target.closest(".osss-moved-tool")) {
        e.stopPropagation();
      }
    });

    dropdownContent.appendChild(menuRoot);

    // Close all open submenus when the user clicks outside the menu.
    if (currentMenuClickListener) {
      document.removeEventListener("click", currentMenuClickListener);
    }
    currentMenuClickListener = () => {
      if (!menuRoot.isConnected) {
        document.removeEventListener("click", currentMenuClickListener);
        currentMenuClickListener = null;
        return;
      }
      menuRoot.querySelectorAll(".osss-folder.osss-open").forEach((f) => f.classList.remove("osss-open"));
    };
    document.addEventListener("click", currentMenuClickListener);
  }

  function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function findNodeAndParent(nodes, targetId, parent = null) {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node.id === targetId) {
        return { node, parent, index: i, siblings: nodes };
      }
      if (node.type === "folder" && Array.isArray(node.children)) {
        const found = findNodeAndParent(node.children, targetId, node);
        if (found) return found;
      }
    }
    return null;
  }

  function removeNodeById(nodes, targetId) {
    const found = findNodeAndParent(nodes, targetId);
    if (!found) return null;
    found.siblings.splice(found.index, 1);
    return found.node;
  }

  function isDescendant(folderNode, maybeDescendantId) {
    if (folderNode.id === maybeDescendantId) return true;
    for (const child of folderNode.children || []) {
      if (child.id === maybeDescendantId) return true;
      if (child.type === "folder" && isDescendant(child, maybeDescendantId)) return true;
    }
    return false;
  }

  async function openManager(dropdownContent, currentTools) {
    const saved = await getStoredTree();
    let workingTree = makeEffectiveTree(saved, currentTools);
    const ROOT_ID = "__root__";
    let selectedFolderId = ROOT_ID;
    let selectedToolId = null;
    let showAllTools = false;
    let draggedToolId = null;
    let draggedFolderId = null;

    const backdrop = document.createElement("div");
    backdrop.className = "osss-modal-backdrop";
    backdrop.classList.toggle("osss-dark", isOnshapeDarkMode());

    const modal = document.createElement("div");
    modal.className = "osss-modal";

    modal.innerHTML = `
      <div class="osss-modal-header">
        <div class="osss-modal-title">Onshape Script Sorter</div>
        <div class="osss-actions">
          <button type="button" class="osss-btn" data-action="save">Save</button>
          <button type="button" class="osss-btn" data-action="cancel">Close</button>
        </div>
      </div>
      <div class="osss-modal-body">
        <div class="osss-hint">Drag tools from the middle list and drop onto a folder on the left.</div>
        <div class="osss-layout">
          <div class="osss-pane osss-pane-left">
            <div class="osss-pane-header">
              <span>Folders</span>
              <div class="osss-actions">
                <button type="button" class="osss-btn" data-action="add-folder">New</button>
                <button type="button" class="osss-btn" data-action="rename-folder">Rename</button>
                <button type="button" class="osss-btn" data-action="delete-folder">Delete</button>
                <button type="button" class="osss-btn" data-action="export-folder">Export</button>
                <button type="button" class="osss-btn" data-action="import-folder">Import</button>
              </div>
            </div>
            <input type="file" data-role="import-file-input" accept=".json" style="display:none">
            <div class="osss-tree-root">
              <ul class="osss-tree" data-root="true"></ul>
            </div>
          </div>

          <div class="osss-pane osss-pane-middle">
            <div class="osss-pane-header">
              <span>Tools</span>
              <button type="button" class="osss-btn" data-action="toggle-filter">Filter: Selected Folder</button>
            </div>
            <div class="osss-tools-list" data-tools-list="true"></div>
          </div>

          <div class="osss-pane osss-pane-right">
            <div class="osss-pane-header"><span>Tool Details</span></div>
            <div class="osss-tool-details" data-tool-details="true"></div>
          </div>
        </div>
      </div>
    `;

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    const treeRoot = modal.querySelector(".osss-tree[data-root='true']");
    const toolsList = modal.querySelector("[data-tools-list='true']");
    const detailsBox = modal.querySelector("[data-tool-details='true']");
    const filterBtn = modal.querySelector('[data-action="toggle-filter"]');

    function decodeHtmlEntities(value) {
      const temp = document.createElement("textarea");
      temp.innerHTML = value || "";
      return temp.value;
    }

    function getFolderById(nodes, folderId) {
      if (folderId === ROOT_ID) {
        return { id: ROOT_ID, name: "Root", children: nodes, isVirtualRoot: true };
      }

      for (const node of nodes) {
        if (node.type === "folder") {
          if (node.id === folderId) return node;
          const found = getFolderById(node.children || [], folderId);
          if (found) return found;
        }
      }

      return null;
    }

    function getFolderContext(folderId, nodes, parentFolderId = ROOT_ID) {
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        if (node.type !== "folder") continue;

        if (node.id === folderId) {
          return { folder: node, siblings: nodes, index: i, parentFolderId };
        }

        const found = getFolderContext(folderId, node.children || [], node.id);
        if (found) return found;
      }

      return null;
    }

    function collectToolIds(nodes, out = [], seen = new Set()) {
      for (const node of nodes || []) {
        if (!node) continue;
        if (node.type === "tool") {
          if (!seen.has(node.id)) {
            seen.add(node.id);
            out.push(node.id);
          }
        } else if (node.type === "folder") {
          collectToolIds(node.children || [], out, seen);
        }
      }
      return out;
    }

    function getToolIdsForFolder(folderId) {
      const folder = getFolderById(workingTree, folderId);
      if (!folder) return [];

      const direct = [];
      for (const node of folder.children || []) {
        if (node?.type === "tool" && node.id) {
          direct.push(node.id);
        }
      }
      return direct;
    }

    function getAllToolIds() {
      const ordered = collectToolIds(workingTree);
      const seen = new Set(ordered);
      for (const id of currentTools.keys()) {
        if (!seen.has(id)) ordered.push(id);
      }
      return ordered;
    }

    function createToolVisual(tool, title) {
      const wrap = document.createElement("div");
      wrap.className = "osss-node-left";

      const iconWrap = document.createElement("div");
      iconWrap.className = "osss-node-icon";
      const icon = tool?.el?.querySelector?.(".tool-icon");
      if (icon) iconWrap.appendChild(icon.cloneNode(true));

      const name = document.createElement("div");
      name.className = "osss-node-name";
      name.textContent = title;

      wrap.appendChild(iconWrap);
      wrap.appendChild(name);
      return wrap;
    }

    function moveToolToFolder(toolId, folderId) {
      const removed = removeNodeById(workingTree, toolId) || { type: "tool", id: toolId };
      const toolNode = { type: "tool", id: removed.id };

      if (folderId === ROOT_ID) {
        workingTree.push(toolNode);
        return;
      }

      const targetFolder = getFolderById(workingTree, folderId);
      if (!targetFolder || targetFolder.type !== "folder") {
        workingTree.push(toolNode);
        return;
      }

      targetFolder.children = targetFolder.children || [];
      targetFolder.children.push(toolNode);
    }

    function moveFolderToFolder(folderId, targetFolderId) {
      if (!folderId || folderId === ROOT_ID) return;
      if (!targetFolderId) return;
      if (folderId === targetFolderId) return;

      const ctx = getFolderContext(folderId, workingTree);
      if (!ctx || !ctx.folder) return;
      const movingFolder = ctx.folder;

      if (targetFolderId !== ROOT_ID && isDescendant(movingFolder, targetFolderId)) {
        return;
      }

      ctx.siblings.splice(ctx.index, 1);

      if (targetFolderId === ROOT_ID) {
        workingTree.push(movingFolder);
        return;
      }

      const targetFolder = getFolderById(workingTree, targetFolderId);
      if (!targetFolder || targetFolder.type !== "folder") {
        workingTree.push(movingFolder);
        return;
      }

      targetFolder.children = targetFolder.children || [];
      targetFolder.children.push(movingFolder);
    }

    function renderDetails() {
      detailsBox.innerHTML = "";

      if (!selectedToolId || !currentTools.has(selectedToolId)) {
        detailsBox.innerHTML = `<div class="osss-detail-empty">Select a tool to view details.</div>`;
        return;
      }

      const tool = currentTools.get(selectedToolId);
      const title = tool.title || "(untitled)";
      const commandId = tool.commandId || "";
      const details = tool.details || "";
      const expanded = decodeHtmlEntities(tool.el.getAttribute("data-bs-expanded-content") || "");

      const top = document.createElement("div");
      top.className = "osss-detail-title";
      top.appendChild(createToolVisual(tool, title));
      detailsBox.appendChild(top);

      const commandRow = document.createElement("div");
      commandRow.className = "osss-detail-row";
      commandRow.innerHTML = `<strong>Command:</strong> ${commandId || "-"}`;
      detailsBox.appendChild(commandRow);

      const detailsRow = document.createElement("div");
      detailsRow.className = "osss-detail-row";
      detailsRow.innerHTML = `<strong>ID:</strong> ${details || "-"}`;
      detailsBox.appendChild(detailsRow);

      if (expanded) {
        const descRow = document.createElement("div");
        descRow.className = "osss-detail-row";
        descRow.innerHTML = `<strong>Description:</strong><div class="osss-detail-desc">${expanded}</div>`;
        detailsBox.appendChild(descRow);
      }
    }

    function renderToolList() {
      toolsList.innerHTML = "";
      filterBtn.textContent = showAllTools ? "Filter: All Tools" : "Filter: Selected Folder";

      const ids = showAllTools ? getAllToolIds() : getToolIdsForFolder(selectedFolderId);

      if (!ids.length) {
        const empty = document.createElement("div");
        empty.className = "osss-detail-empty";
        empty.textContent = "No tools in this view.";
        toolsList.appendChild(empty);
        if (selectedToolId) {
          selectedToolId = null;
          renderDetails();
        }
        return;
      }

      if (!ids.includes(selectedToolId)) {
        selectedToolId = ids[0] || null;
      }

      for (const id of ids) {
        const tool = currentTools.get(id);
        if (!tool) continue;

        const row = document.createElement("div");
        row.className = "osss-node-row osss-node-row-tool";
        if (id === selectedToolId) row.classList.add("osss-selected");
        row.draggable = true;
        row.dataset.toolId = id;

        row.appendChild(createToolVisual(tool, tool.title));

        row.addEventListener("click", () => {
          selectedToolId = id;
          renderToolList();
          renderDetails();
        });

        row.addEventListener("dragstart", (e) => {
          draggedToolId = id;
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", id);
          }
        });

        row.addEventListener("dragend", () => {
          draggedToolId = null;
        });

        toolsList.appendChild(row);
      }

      renderDetails();
    }

    function renderFolderTree() {
      treeRoot.innerHTML = "";

      const renderFolderNode = (folder, parentUl) => {
        const li = document.createElement("li");
        li.dataset.nodeType = "folder";
        li.dataset.nodeId = folder.id;

        const row = document.createElement("div");
        row.className = "osss-node-row osss-node-row-folder";
        if (folder.id === selectedFolderId) row.classList.add("osss-selected");
        row.draggable = folder.id !== ROOT_ID;

        const left = document.createElement("div");
        left.className = "osss-node-left";

        const icon = document.createElement("div");
        icon.className = "osss-node-icon";
        icon.textContent = "📁";

        const name = document.createElement("div");
        name.className = "osss-node-name";
        name.textContent = folder.name;

        left.appendChild(icon);
        left.appendChild(name);
        row.appendChild(left);

        row.addEventListener("click", () => {
          selectedFolderId = folder.id;
          if (showAllTools) showAllTools = false;
          renderFolderTree();
          renderToolList();
        });

        row.addEventListener("dragstart", (e) => {
          if (folder.id === ROOT_ID) return;
          draggedFolderId = folder.id;
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", folder.id);
          }
        });

        row.addEventListener("dragend", () => {
          draggedFolderId = null;
        });

        row.addEventListener("dragover", (e) => {
          if (!draggedToolId && !draggedFolderId) return;
          e.preventDefault();
          row.classList.add("osss-drop-target");
        });

        row.addEventListener("dragleave", () => {
          row.classList.remove("osss-drop-target");
        });

        row.addEventListener("drop", (e) => {
          e.preventDefault();
          e.stopPropagation();
          row.classList.remove("osss-drop-target");
          if (draggedToolId) {
            moveToolToFolder(draggedToolId, folder.id);
            selectedToolId = draggedToolId;
            draggedToolId = null;
          } else if (draggedFolderId) {
            moveFolderToFolder(draggedFolderId, folder.id);
            draggedFolderId = null;
          } else {
            return;
          }

          renderFolderTree();
          renderToolList();
        });

        li.appendChild(row);

        const childFolders = (folder.children || []).filter((child) => child.type === "folder");
        if (childFolders.length) {
          const childUl = document.createElement("ul");
          childFolders.forEach((childFolder) => {
            renderFolderNode(childFolder, childUl);
          });
          li.appendChild(childUl);
        }

        parentUl.appendChild(li);
      };

      const virtualRoot = { id: ROOT_ID, name: "Root", children: workingTree };
      renderFolderNode(virtualRoot, treeRoot);
    }

    function rerenderAll() {
      renderFolderTree();
      renderToolList();
    }

    modal.querySelector('[data-action="add-folder"]').addEventListener("click", () => {
      const name = prompt("Folder name", "New Folder");
      if (!name) return;

      const newFolder = {
        type: "folder",
        id: getNextFolderId(),
        name: name.trim() || "New Folder",
        children: []
      };

      if (selectedFolderId === ROOT_ID) {
        workingTree.push(newFolder);
      } else {
        const parentFolder = getFolderById(workingTree, selectedFolderId);
        if (parentFolder && parentFolder.type === "folder") {
          parentFolder.children = parentFolder.children || [];
          parentFolder.children.push(newFolder);
        } else {
          workingTree.push(newFolder);
        }
      }

      selectedFolderId = newFolder.id;
      showAllTools = false;
      rerenderAll();
    });

    modal.querySelector('[data-action="rename-folder"]').addEventListener("click", () => {
      if (selectedFolderId === ROOT_ID) return;
      const folder = getFolderById(workingTree, selectedFolderId);
      if (!folder || folder.type !== "folder") return;

      const newName = prompt("Folder name", folder.name || "Folder");
      if (!newName) return;
      folder.name = newName.trim() || folder.name;
      renderFolderTree();
    });

    modal.querySelector('[data-action="delete-folder"]').addEventListener("click", () => {
      if (selectedFolderId === ROOT_ID) return;
      const ctx = getFolderContext(selectedFolderId, workingTree);
      if (!ctx) return;

      const removed = ctx.siblings.splice(ctx.index, 1)[0];
      if (removed?.children?.length) {
        ctx.siblings.push(...removed.children);
      }

      selectedFolderId = ctx.parentFolderId || ROOT_ID;
      showAllTools = false;
      rerenderAll();
    });

    function exportFolderSubtree(node) {
      if (node.type === "tool") {
        return { type: "tool", id: node.id };
      }
      return {
        type: "folder",
        name: node.name || "Folder",
        children: (node.children || []).map(exportFolderSubtree)
      };
    }

    function folderNameToFilename(name) {
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      return "osss-" + (slug || "folder") + ".json";
    }

    modal.querySelector('[data-action="export-folder"]').addEventListener("click", () => {
      let exportData;
      let filename;
      if (selectedFolderId === ROOT_ID) {
        exportData = {
          version: "1",
          type: "osss-folder-pack",
          folders: workingTree.filter((n) => n.type === "folder").map(exportFolderSubtree)
        };
        filename = "osss-all-folders.json";
      } else {
        const folder = getFolderById(workingTree, selectedFolderId);
        if (!folder || folder.type !== "folder") return;
        exportData = {
          version: "1",
          type: "osss-folder-pack",
          folders: [exportFolderSubtree(folder)]
        };
        filename = folderNameToFilename(folder.name || "folder");
      }

      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      try {
        a.click();
      } finally {
        a.remove();
        URL.revokeObjectURL(url);
      }
    });

    function importFolderSubtree(node) {
      if (!node || typeof node !== "object") return null;
      if (node.type === "tool" && node.id) {
        return { type: "tool", id: node.id };
      }
      if (node.type === "folder") {
        return {
          type: "folder",
          id: getNextFolderId(),
          name: node.name || "Imported Folder",
          children: (Array.isArray(node.children) ? node.children : [])
            .map(importFolderSubtree)
            .filter(Boolean)
        };
      }
      return null;
    }

    const importFileInput = modal.querySelector('[data-role="import-file-input"]');
    modal.querySelector('[data-action="import-folder"]').addEventListener("click", () => {
      importFileInput.value = "";
      importFileInput.click();
    });

    function mergeFolderChildren(existingFolder, incomingFolder) {
      existingFolder.children = existingFolder.children || [];
      for (const child of incomingFolder.children || []) {
        if (child.type === "tool") {
          const alreadyPresent = existingFolder.children.some(
            (c) => c.type === "tool" && c.id === child.id
          );
          if (!alreadyPresent) existingFolder.children.push({ type: "tool", id: child.id });
        } else if (child.type === "folder") {
          const matchingSub = existingFolder.children.find(
            (c) => c.type === "folder" && c.name === child.name
          );
          if (matchingSub) {
            mergeFolderChildren(matchingSub, child);
          } else {
            existingFolder.children.push(importFolderSubtree(child));
          }
        }
      }
    }

    function resolveImportConflicts(incoming, targetChildren) {
      const decisions = new Map();
      for (const folder of incoming) {
        if (folder.type !== "folder") continue;
        const existing = targetChildren.find(
          (c) => c.type === "folder" && c.name === folder.name
        );
        if (!existing) continue;

        const choice = prompt(
          `A folder named "${folder.name}" already exists here.\n\nChoose an action:\n  merge   – combine contents (keep both)\n  replace – overwrite existing folder\n  skip    – do not import this folder\n\nType merge, replace, or skip:`,
          "merge"
        );

        decisions.set(folder, (choice || "skip").trim().toLowerCase());
      }
      return decisions;
    }

    function applyImportedFolders(incoming, targetChildren, decisions) {
      for (const folder of incoming) {
        if (folder.type !== "folder") {
          targetChildren.push(folder);
          continue;
        }

        const existingIdx = targetChildren.findIndex(
          (c) => c.type === "folder" && c.name === folder.name
        );
        const action = decisions.get(folder);

        if (existingIdx === -1 || action === undefined) {
          targetChildren.push(folder);
        } else if (action === "replace") {
          folder.id = getNextFolderId();
          targetChildren.splice(existingIdx, 1, folder);
        } else if (action === "merge") {
          mergeFolderChildren(targetChildren[existingIdx], folder);
        }
        // "skip" — do nothing
      }
    }

    importFileInput.addEventListener("change", () => {
      const file = importFileInput.files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onerror = () => {
        alert("Failed to read the file.");
      };
      reader.onload = (e) => {
        let parsed;
        try {
          parsed = JSON.parse(e.target.result);
        } catch {
          alert("Invalid JSON file.");
          return;
        }

        if (
          !parsed ||
          parsed.type !== "osss-folder-pack" ||
          !Array.isArray(parsed.folders) ||
          !parsed.folders.length
        ) {
          alert("Not a valid folder pack file.");
          return;
        }

        const imported = parsed.folders.map(importFolderSubtree).filter(Boolean);

        let targetChildren;
        if (selectedFolderId === ROOT_ID) {
          targetChildren = workingTree;
        } else {
          const targetFolder = getFolderById(workingTree, selectedFolderId);
          if (targetFolder && targetFolder.type === "folder") {
            targetFolder.children = targetFolder.children || [];
            targetChildren = targetFolder.children;
          } else {
            targetChildren = workingTree;
          }
        }

        const decisions = resolveImportConflicts(imported, targetChildren);
        applyImportedFolders(imported, targetChildren, decisions);

        rerenderAll();
      };
      reader.readAsText(file);
    });

    filterBtn.addEventListener("click", () => {
      showAllTools = !showAllTools;
      renderToolList();
    });

    modal.querySelector('[data-action="save"]').addEventListener("click", async () => {
      await saveTree(workingTree);
      if (dropdownContent && currentTools?.size) {
        const refreshedTree = makeEffectiveTree(await getStoredTree(), currentTools);
        buildMenu(dropdownContent, refreshedTree, currentTools);
      }
      backdrop.remove();
    });

    modal.querySelector('[data-action="cancel"]').addEventListener("click", () => {
      backdrop.remove();
    });

    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) backdrop.remove();
    });

    rerenderAll();
  }

  async function processDropdown(dropdownContent) {
    const currentTools = scanCurrentTools(dropdownContent);
    if (!currentTools.size) return;

    const signature = [...currentTools.keys()].join("||");
    if (signature === state.lastSignature && dropdownContent.querySelector(".osss-menu-root")) {
      return;
    }

    state.lastSignature = signature;
    state.currentTools = currentTools;

    const savedTree = await getStoredTree();
    const effectiveTree = makeEffectiveTree(savedTree, currentTools);

    buildMenu(dropdownContent, effectiveTree, currentTools);
  }

  function findAndProcess() {
    const dropdowns = document.querySelectorAll(".os-tool-dropdown-content");
    dropdowns.forEach((dropdown) => {
      void processDropdown(dropdown);
    });
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function ensureDropdownAvailable() {
    let dropdown = document.querySelector(".os-tool-dropdown-content");
    if (dropdown) return dropdown;

    const arrow = document.querySelector(
      ".toolset[data-name='user-specified-feature-tools'] .dropdown-arrow"
    );

    if (arrow) {
      arrow.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      arrow.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      arrow.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }

    const timeoutAt = Date.now() + 2500;
    while (Date.now() < timeoutAt) {
      dropdown = document.querySelector(".os-tool-dropdown-content");
      if (dropdown) return dropdown;
      await wait(60);
    }

    return null;
  }

  function getBestDropdownAndTools() {
    const dropdowns = [...document.querySelectorAll(".os-tool-dropdown-content")];
    let best = null;

    for (const dropdown of dropdowns) {
      const tools = scanCurrentTools(dropdown);
      if (!tools.size) continue;
      if (!best || tools.size > best.tools.size) {
        best = { dropdown, tools };
      }
    }

    return best;
  }

  function startObserver() {
    if (state.observer) return;

    state.observer = new MutationObserver(() => {
      clearTimeout(state.rerenderTimer);
      state.rerenderTimer = setTimeout(findAndProcess, 100);
    });

    state.observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  function init() {
    findAndProcess();
    startObserver();

    // Re-theme extension UI whenever Onshape's own dark/light mode changes.
    let _lastDark = isOnshapeDarkMode();
    new MutationObserver(() => {
      const dark = isOnshapeDarkMode();
      if (dark === _lastDark) return;
      _lastDark = dark;
      document.querySelectorAll(".osss-menu-root, .osss-modal-backdrop").forEach((el) => {
        el.classList.toggle("osss-dark", dark);
      });
    }).observe(document.body, { attributes: true, attributeFilter: ["class", "style"] });

    if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (message?.type !== "OSSS_OPEN_MANAGER") return;

        void (async () => {
          await ensureDropdownAvailable();
          findAndProcess();

          const best = getBestDropdownAndTools();
          if (!best) {
            sendResponse({ ok: false, error: "NO_TOOLS_FOUND" });
            return;
          }

          await openManager(best.dropdown, best.tools);
          sendResponse({ ok: true });
        })();

        return true;
      });
    }

    window.addEventListener("beforeunload", () => {
      if (state.observer) state.observer.disconnect();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
