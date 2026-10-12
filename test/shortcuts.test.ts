import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { transpileModule, ScriptTarget } from "typescript";

// Exercise the actual capture-phase listener without loading Obsidian or opening windows.
const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const start = source.indexOf('this.registerDomEvent(win, "keydown", (event) => {');
const end = source.indexOf("\n    }, true);", start);
assert(start >= 0 && end > start, "window keydown listener must be present");
const listener = transpileModule(source.slice(start, end + "\n    }, true);".length), {
  compilerOptions: { target: ScriptTarget.ES2022 }
}).outputText;

function dispatchKey(isMacOS: boolean, key: string, modifiers: Partial<{
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing: boolean;
}> = {}) {
  const calls: string[] = [];
  let handler: (event: KeyboardEvent) => void = () => assert.fail("listener was not registered");
  const actions = [
    "openActionPanel", "openSwitcher", "createAndOpenNote", "duplicateCurrentNote",
    "wrapSelection", "openLinkPopover", "deleteCurrentNote", "hideInlineProperties"
  ];
  const plugin = {
    ...Object.fromEntries(actions.map(action => [action, () => calls.push(action)])),
    activateWindow() {},
    hasOpenOverlay: () => false,
    registerDomEvent(_win: unknown, type: string, callback: typeof handler, capture: boolean) {
      assert.equal(type, "keydown");
      assert.equal(capture, true);
      handler = callback;
    }
  };
  const doc = { querySelector: () => null };
  runInNewContext(`(function () { ${listener} }).call(plugin)`, {
    plugin, doc, document: doc, win: {}, context: {}, IS_MACOS: isMacOS,
    shouldHideWindowOnEscape: () => false,
    isImeProcessKey: () => false
  });
  const event = {
    key, code: `Key${key.toUpperCase()}`,
    metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false,
    ...modifiers,
    defaultPrevented: false, stopped: false, immediateStopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.stopped = true; },
    stopImmediatePropagation() { this.immediateStopped = true; }
  };
  handler(event as unknown as KeyboardEvent);
  return { calls, event };
}

const shortcuts = [
  ["k", "openActionPanel"], ["p", "openSwitcher"], ["n", "createAndOpenNote"],
  ["d", "duplicateCurrentNote"], ["u", "wrapSelection"], ["l", "openLinkPopover"]
] as const;

test("leaves macOS Control editing keys available to the editor", () => {
  for (const key of ["k", "p", "n", "d", "u", "l", "f"]) {
    const { calls, event } = dispatchKey(true, key, { ctrlKey: true });
    assert.deepEqual(calls, [], `Control+${key} must not run a plugin action`);
    assert.equal(event.defaultPrevented, false);
    assert.equal(event.stopped, false);
    assert.equal(event.immediateStopped, false);
  }
});

test("keeps macOS Command shortcuts, including shifted and Option formatting actions", () => {
  for (const [key, action] of [...shortcuts, ["s", "wrapSelection"], ["e", "wrapSelection"]]) {
    const { calls, event } = dispatchKey(true, key, {
      metaKey: true, shiftKey: key === "s", altKey: key === "e"
    });
    assert.deepEqual(calls, [action]);
    assert.equal(event.defaultPrevented, true);
    assert.equal(event.immediateStopped, true);
  }
});

test("keeps Control shortcuts on Windows and Linux", () => {
  for (const [key, action] of [...shortcuts, ["s", "wrapSelection"], ["e", "wrapSelection"]]) {
    const { calls, event } = dispatchKey(false, key, {
      ctrlKey: true, shiftKey: key === "s", altKey: key === "e"
    });
    assert.deepEqual(calls, [action]);
    assert.equal(event.defaultPrevented, true);
  }
});

test("does not treat the Windows or Linux Meta key as Control", () => {
  for (const key of ["k", "p", "n", "d", "u", "l", "f"]) {
    const { calls, event } = dispatchKey(false, key, { metaKey: true });
    assert.deepEqual(calls, []);
    assert.equal(event.defaultPrevented, false);
    assert.equal(event.stopped, false);
  }
});

test("preserves the explicit Control+X delete-note shortcut on both platforms", () => {
  for (const isMacOS of [true, false]) {
    const { calls, event } = dispatchKey(isMacOS, "x", { ctrlKey: true });
    assert.deepEqual(calls, ["deleteCurrentNote"]);
    assert.equal(event.defaultPrevented, true);
  }
});

test("keeps find handling tied to the platform's primary modifier", () => {
  for (const isMacOS of [true, false]) {
    const { calls, event } = dispatchKey(isMacOS, "f", isMacOS ? { metaKey: true } : { ctrlKey: true });
    assert.deepEqual(calls, ["hideInlineProperties"]);
    assert.equal(event.defaultPrevented, false);
  }
});

test("does not execute plugin actions during IME composition", () => {
  for (const isMacOS of [true, false]) {
    const { calls, event } = dispatchKey(isMacOS, "k", {
      ...(isMacOS ? { metaKey: true } : { ctrlKey: true }), isComposing: true
    });
    assert.deepEqual(calls, []);
    assert.equal(event.defaultPrevented, false);
    assert.equal(event.immediateStopped, true);
  }
});
