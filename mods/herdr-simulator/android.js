import { exec, appHome } from "herdr";

// Linux: Android Studio puts the SDK in ~/Android/Sdk, and Herdr may start without ANDROID_HOME.
export const SDK = 'sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"; [ -n "$sdk" ] || { [ -d "$HOME/Android/Sdk" ] && sdk="$HOME/Android/Sdk" || sdk="$HOME/Library/Android/sdk"; }';

// Runs `adb -s <serial> <args...>` through sh so the SDK path resolves as in a terminal.
const adb = (serial, args) => exec("sh", ["-c", `${SDK}; s="$1"; shift; exec "$sdk/platform-tools/adb" -s "$s" "$@"`, "sh", serial, ...args]);

// USB HID keyboard usages (what the key handler produces) -> Android key codes.
const KEYCODES = {
  40: 66, 41: 111, 42: 67, 43: 61, 44: 62, 45: 69, 46: 70, 47: 71, 48: 72, 49: 73, 51: 74, 52: 75, 53: 68,
  54: 55, 55: 56, 56: 76, 74: 122, 75: 92, 76: 112, 77: 123, 78: 93, 79: 22, 80: 21, 81: 20, 82: 19,
};
for (let u = 4; u <= 29; u++) KEYCODES[u] = u + 25;
for (let u = 30; u <= 38; u++) KEYCODES[u] = u - 22;
KEYCODES[39] = 7;
const SHIFT = 225;
const MODIFIERS = new Set([224, 225, 226, 227]);
const BUTTONS = { home: 3, lock: 26 };
const VOLUME = { 233: 24, 234: 25 };

// The emulator's serial (emulator-5554) for an AVD name, or null when it isn't running.
export async function serialOf(avd) {
  const r = await exec("sh", ["-c", `${SDK}
for s in $("$sdk/platform-tools/adb" devices | awk '/^emulator-/ {print $1}'); do
  [ "$("$sdk/platform-tools/adb" -s "$s" emu avd name 2>/dev/null | head -1 | tr -d '\\r')" = "$1" ] && echo "$s" && exit 0
done`, "sh", avd]);
  return r.stdout.trim() || null;
}

export async function startAndroid(device) {
  const serial = await serialOf(device.avd);
  if (!serial) throw new Error(`${device.name} has no adb connection yet`);
  const m = /(\d+)x(\d+)/.exec((await adb(serial, ["shell", "wm", "size"])).stdout);
  const size = m ? { width: Number(m[1]), height: Number(m[2]) } : { width: 1080, height: 2220 };
  // Rotation follows the emulator, the way a phone follows how it's held.
  await adb(serial, ["shell", "settings", "put", "system", "accelerometer_rotation", "1"]);
  const port = await startStream(serial);
  const input = new AdbInput(serial, size);
  await input.orient();
  return { device, serial, size, input, host: "127.0.0.1", port, path: "/stream" };
}

// About the width the panel shows the screen at on a Retina display.
const STREAM_WIDTH = 540;

// Starts android-stream.mjs for the emulator unless one already serves it
// (another view of the same emulator), and returns once it listens. One helper
// per emulator, on a port from its console port: emulator-5554 -> 32554. It is
// started through the login shell, whose PATH finds a working node.
async function startStream(serial) {
  const consolePort = serial.split("-")[1];
  const port = String(27000 + Number(consolePort));
  const script = [
    'nc -z 127.0.0.1 "$3" && exit 0',
    'nohup "${SHELL:-/bin/zsh}" -lic \'exec node "$@"\' node "$1" "$2" "$3" "$4" >/dev/null 2>&1 &',
    'for i in $(seq 50); do sleep 0.1; nc -z 127.0.0.1 "$3" && exit 0; done',
    'exit 1',
  ].join("\n");
  const r = await exec("sh", ["-c", script, "sh", `${appHome()}/mods/herdr-simulator/android-stream.mjs`, consolePort, port, String(STREAM_WIDTH)]);
  if (r.code !== 0) throw new Error("the emulator's screen stream didn't start");
  return Number(port);
}

// Native (portrait panel) point -> the display's own coordinates at rotation r, which
// is what `input` takes; and back. Android's convention: ROTATION_90 is (y, W - x).
function toDisplay([x, y], r, W, H) {
  return [[x, y], [y, W - x], [W - x, H - y], [H - y, x]][r];
}
function fromDisplay([x, y], r, W, H) {
  return [[x, y], [W - y, x], [W - x, H - y], [y, H - x]][r];
}

// The same surface as serve-sim's Input, over `adb shell input`. Points are 0..1.
export class AdbInput {
  constructor(serial, size) {
    this.serial = serial;
    this.size = size;
    this.queue = Promise.resolve();
    this.move = null;
    this.held = new Set();
    // `turned`: how the emulator is held (the frames come this way up). `display`: how the
    // app on screen is drawn, which differs when it locks its orientation.
    this.turned = 0;
    this.display = 0;
  }

  // The media volume, which the volume keys change: { level, max }, or null.
  async volume() {
    const r = await adb(this.serial, ["shell", "cmd", "media_session", "volume", "--stream", "3", "--get"]);
    const m = /volume is (\d+) in range \[\d+\.\.(\d+)\]/.exec(r.stdout);
    return m ? { level: Number(m[1]), max: Number(m[2]) } : null;
  }

  // Reads both rotations. Cheap (one dumpsys section), so it runs after every gesture.
  async orient() {
    const r = await adb(this.serial, ["shell", "dumpsys window displays | grep -oE 'mCurrentRotation=ROTATION_[0-9]+|mProposedRotation=-?[0-9]+'"]);
    const display = /ROTATION_(\d+)/.exec(r.stdout);
    const proposed = /mProposedRotation=(-?\d+)/.exec(r.stdout);
    if (display) this.display = Number(display[1]) / 90;
    // No sensor reading yet: the emulator is held the way the display is drawn.
    this.turned = proposed && Number(proposed[1]) >= 0 ? Number(proposed[1]) : this.display;
  }

  // Commands run one at a time, in order. Input is fire-and-forget, so a failure is logged.
  run(command) {
    this.queue = this.queue.then(command).catch((e) => console.log(`adb input: ${e.message ?? e}`));
    return this.queue;
  }

  shell(args) {
    return this.run(() => adb(this.serial, ["shell", ...args]));
  }

  // A point on the frame -> the panel -> the display's coordinates.
  px(p) {
    const { width: W, height: H } = this.size;
    const odd = this.turned % 2 === 1;
    const frame = [p.x * ((odd ? H : W) - 1), p.y * ((odd ? W : H) - 1)];
    const [x, y] = toDisplay(fromDisplay(frame, this.turned, W - 1, H - 1), this.display, W - 1, H - 1);
    return [String(Math.round(x)), String(Math.round(y))];
  }

  // Moves that pile up behind a slow command collapse into the latest one.
  touch(type, p) {
    if (type === "move") {
      const queued = this.move != null;
      this.move = p;
      if (queued) return this.queue;
      return this.run(() => {
        const at = this.move;
        this.move = null;
        return at && adb(this.serial, ["shell", "input", "motionevent", "MOVE", ...this.px(at)]);
      });
    }
    this.move = null;
    const sent = this.shell(["input", "motionevent", type === "begin" ? "DOWN" : "UP", ...this.px(p)]);
    // A tap can open an app that draws another way up.
    if (type === "end") this.run(() => this.orient());
    return sent;
  }

  key(type, usage) {
    if (MODIFIERS.has(usage)) return type === "down" ? this.held.add(usage) : this.held.delete(usage);
    const code = KEYCODES[usage];
    if (type !== "down" || code == null) return;
    return this.held.has(SHIFT)
      ? this.shell(["input", "keycombination", "59", String(code)])
      : this.shell(["input", "keyevent", String(code)]);
  }

  button(name) {
    return BUTTONS[name] != null && this.shell(["input", "keyevent", String(BUTTONS[name])]);
  }

  hid(_page, usage) {
    return VOLUME[usage] != null && this.shell(["input", "keyevent", String(VOLUME[usage])]);
  }

  // dx, dy: a fraction of the screen; positive scrolls toward what is below / right.
  scroll(dx, dy, p) {
    const to = { x: clamp01(p.x - dx), y: clamp01(p.y - dy) };
    return this.shell(["input", "swipe", ...this.px(p), ...this.px(to), "120"]);
  }

  // Turns the emulator itself, as turning the phone in your hand: the frames come the
  // new way up, and apps that allow it rotate with it. Then the rotations are read again
  // once Android has caught up.
  // Each `emu rotate` turns it a quarter the same way (0, 3, 2, 1), so a press goes from
  // portrait to landscape, and from any other way up straight back to portrait.
  rotate() {
    return this.run(async () => {
      await this.orient();
      const steps = this.turned === 0 ? 1 : this.turned;
      for (let i = 0; i < steps; i++) await adb(this.serial, ["emu", "rotate"]);
      await adb(this.serial, ["shell", "settings put system accelerometer_rotation 1; sleep 0.8"]);
      await this.orient();
    });
  }

  close() {}
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));
