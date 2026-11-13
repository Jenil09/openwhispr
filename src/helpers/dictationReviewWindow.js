const crypto = require("crypto");
const path = require("path");
const { BrowserWindow, globalShortcut, ipcMain, screen } = require("electron");
const DevServerManager = require("./devServerManager");
const debugLogger = require("./debugLogger");
const { WindowPositionUtil } = require("./windowConfig");

// Review card for the rewrite chain (personal fork feature). It never takes
// focus, so the app the user dictated into keeps it and the approved paste
// lands where the caret was. Keys reach it through global shortcuts that exist
// only while a review is open.

const WIDTH = 600;
const INITIAL_HEIGHT = 260;
const MAX_HEIGHT = 640;
const BOTTOM_MARGIN = 140;
const MAX_TIMEOUT_MS = 10 * 60 * 1000;

const APPROVE_KEYS = ["Y", "Return"];
const REJECT_KEYS = ["N", "Escape"];

class DictationReviewWindow {
  constructor() {
    this.win = null;
    this.loading = null;
    this.pending = null;
    this.registeredKeys = [];
  }

  registerIpc() {
    ipcMain.handle("dictation-review-request", (event, payload) => this.request(payload));
    ipcMain.handle("dictation-review-get", () => this._publicPayload());
    ipcMain.handle("dictation-review-respond", (_event, id, approved) => {
      if (!this.pending || this.pending.id !== id) return { success: false };
      this._finish(approved ? "approved" : "rejected");
      return { success: true };
    });
    ipcMain.handle("dictation-review-resize", (_event, id, height) => {
      if (!this.pending || this.pending.id !== id) return { success: false };
      this._place(height);
      this._reveal();
      return { success: true };
    });
  }

  _publicPayload() {
    if (!this.pending) return null;
    const { id, stages, finalText, timeoutMs, deadline } = this.pending;
    return { id, stages, finalText, timeoutMs, deadline };
  }

  async _ensureWindow() {
    if (this.win && !this.win.isDestroyed()) {
      if (this.loading) await this.loading;
      return this.win;
    }
    const win = new BrowserWindow({
      width: WIDTH,
      height: INITIAL_HEIGHT,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      focusable: false,
      hasShadow: false,
      show: false,
      acceptFirstMouse: true,
      visibleOnAllWorkspaces: process.platform !== "win32",
      webPreferences: {
        preload: path.join(__dirname, "..", "..", "preload.js"),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    this.win = win;
    win.setContentProtection(true);
    WindowPositionUtil.setupAlwaysOnTop(win, { level: "screen-saver" });
    win.on("closed", () => {
      if (this.win !== win) return;
      this.win = null;
      this.loading = null;
      if (this.pending) this._finish("unavailable");
    });
    win.webContents.on("render-process-gone", () => {
      if (this.pending) this._finish("unavailable");
      if (!win.isDestroyed()) win.destroy();
    });

    this.loading = (async () => {
      if (process.env.NODE_ENV === "development") {
        await DevServerManager.waitForDevServer();
        await win.loadURL(DevServerManager.getAppUrl(false, { "dictation-review": "true" }));
      } else {
        const fileInfo = DevServerManager.getAppFilePath(false, { "dictation-review": "true" });
        await win.loadFile(fileInfo.path, { query: fileInfo.query });
      }
    })();
    try {
      await this.loading;
    } finally {
      this.loading = null;
    }
    return win;
  }

  async request(payload) {
    // A newer dictation's review replaces an unanswered one, which pastes nothing.
    if (this.pending) this._finish("superseded");

    const timeoutMs = Math.min(
      Math.max(Number(payload?.timeoutMs) || 120_000, 5_000),
      MAX_TIMEOUT_MS
    );
    const id = crypto.randomUUID();
    let resolve;
    const promise = new Promise((r) => (resolve = r));
    this.pending = {
      id,
      stages: Array.isArray(payload?.stages) ? payload.stages : [],
      finalText: String(payload?.finalText ?? ""),
      timeoutMs,
      deadline: Date.now() + timeoutMs,
      resolve,
      revealed: false,
      timer: setTimeout(() => {
        if (this.pending?.id === id) this._finish("timeout");
      }, timeoutMs),
      revealFallback: null,
    };

    let win;
    try {
      win = await this._ensureWindow();
    } catch (error) {
      debugLogger.warn(
        "Dictation review window failed to load",
        { error: error.message },
        "review"
      );
      if (this.pending?.id === id) this._finish("unavailable");
      return promise;
    }
    if (this.pending?.id !== id) return promise;

    this._place(INITIAL_HEIGHT);
    win.webContents.send("dictation-review-data", this._publicPayload());
    // The renderer reveals the card once it has measured it; show it anyway if
    // that never arrives.
    this.pending.revealFallback = setTimeout(() => this._reveal(), 600);
    this._registerKeys(id);
    return promise;
  }

  _place(contentHeight) {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    const height = Math.max(
      120,
      Math.min(Math.ceil(Number(contentHeight) || INITIAL_HEIGHT), MAX_HEIGHT)
    );
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const area = display.workArea;
    const width = Math.min(WIDTH, area.width - 32);
    const x = Math.round(area.x + (area.width - width) / 2);
    const y = Math.round(
      Math.max(
        area.y + 16,
        area.y + area.height - height - Math.min(BOTTOM_MARGIN, area.height / 5)
      )
    );
    win.setBounds({ x, y, width, height });
  }

  _reveal() {
    const win = this.win;
    if (!this.pending || this.pending.revealed || !win || win.isDestroyed()) return;
    this.pending.revealed = true;
    clearTimeout(this.pending.revealFallback);
    win.showInactive();
  }

  _registerKeys(id) {
    this._unregisterKeys();
    const bind = (keys, approved) => {
      for (const key of keys) {
        // A key some other feature holds right now (e.g. Esc during a recording)
        // stays with it; the card's buttons still answer.
        if (globalShortcut.isRegistered(key)) continue;
        try {
          const ok = globalShortcut.register(key, () => {
            if (this.pending?.id === id) this._finish(approved ? "approved" : "rejected");
          });
          if (ok) this.registeredKeys.push(key);
        } catch (error) {
          debugLogger.warn("Review key not registered", { key, error: error.message }, "review");
        }
      }
    };
    bind(APPROVE_KEYS, true);
    bind(REJECT_KEYS, false);
  }

  _unregisterKeys() {
    for (const key of this.registeredKeys) {
      try {
        globalShortcut.unregister(key);
      } catch {
        // Already gone.
      }
    }
    this.registeredKeys = [];
  }

  _finish(reason) {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    clearTimeout(pending.timer);
    clearTimeout(pending.revealFallback);
    this._unregisterKeys();
    const win = this.win;
    if (win && !win.isDestroyed()) {
      win.hide();
      win.webContents.send("dictation-review-data", null);
    }
    debugLogger.info("Dictation review settled", { reason }, "review");
    pending.resolve({ approved: reason === "approved", reason });
  }

  dispose() {
    if (this.pending) this._finish("unavailable");
    this._unregisterKeys();
  }
}

module.exports = { DictationReviewWindow };
