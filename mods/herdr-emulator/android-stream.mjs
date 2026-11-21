// Serves an Android emulator's screen as a multipart stream of PNGs, the shape
// serve-sim's MJPEG has, so the mod reads both the same way.
// usage: node android-stream.mjs <console port, e.g. 5554> <listen port> <width>
//
// Frames come from the emulator's gRPC streamScreenshot, which pushes a frame
// whenever the screen changes (~36 fps at 540 wide, against ~6 fps for adb
// screencap). One gRPC stream feeds every viewer; the helper exits a few
// seconds after the last one leaves, or when the emulator goes away.
import net from "node:net";
import http2 from "node:http2";
import { readFileSync, readdirSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";

const [, , consolePort, listenPort, width = "540"] = process.argv;
const IDLE_MS = 3000;

// The emulator advertises its gRPC port and token in a discovery file per instance.
function discover() {
  const dirs = [
    `${homedir()}/Library/Caches/TemporaryItems/avd/running`,
    process.env.XDG_RUNTIME_DIR && `${process.env.XDG_RUNTIME_DIR}/avd/running`,
    `/run/user/${userInfo().uid}/avd/running`,
    `${tmpdir()}/android-${userInfo().username}/avd/running`,
  ].filter(Boolean);
  const files = dirs.flatMap((dir) => {
    try { return readdirSync(dir).filter((f) => f.endsWith(".ini")).map((f) => `${dir}/${f}`); } catch { return []; }
  });
  for (const file of files) {
    const ini = readFileSync(file, "utf8");
    const get = (k) => new RegExp(`^${k}=(.*)$`, "m").exec(ini)?.[1];
    if (get("port.serial") === consolePort) return { port: get("grpc.port"), token: get("grpc.token") };
  }
  throw new Error(`no running emulator on console port ${consolePort}`);
}

const varint = (n) => {
  const out = [];
  for (; n > 127; n >>>= 7) out.push((n & 127) | 128);
  out.push(n);
  return out;
};

// The `image` bytes (field 4) of an Image message.
function imageBytes(msg) {
  let i = 0;
  const read = () => {
    let v = 0;
    for (let shift = 0; ; shift += 7) {
      const b = msg[i++];
      v += (b & 127) * 2 ** shift;
      if (!(b & 128)) return v;
    }
  };
  while (i < msg.length) {
    const key = read();
    const type = key & 7;
    if (type === 2) {
      const len = read();
      if (key >> 3 === 4) return msg.subarray(i, i + len);
      i += len;
    } else if (type === 0) read();
    else if (type === 1) i += 8;
    else if (type === 5) i += 4;
    else return null;
  }
  return null;
}

const viewers = new Set();
// The emulator only sends a frame when the screen changes, so a new viewer starts from the last one.
let last = null;
let idle = null;
const stopSoon = () => { idle ??= setTimeout(() => process.exit(0), IDLE_MS); };

const { port, token } = discover();
const grpc = http2.connect(`http://127.0.0.1:${port}`);
grpc.on("error", () => process.exit(1));
// ImageFormat { format: PNG, width, height }: the frame fits inside width x height. A square
// box keeps the short side at `width` both ways up: 540x1200 in portrait, 1200x540 in landscape.
const box = Math.round((Number(width) * 20) / 9);
const format = [8, 0, 24, ...varint(box), 32, ...varint(box)];
const call = grpc.request({
  ":method": "POST",
  ":path": "/android.emulation.control.EmulatorController/streamScreenshot",
  "content-type": "application/grpc",
  te: "trailers",
  ...(token ? { authorization: `Bearer ${token}` } : {}),
});
// gRPC frames a message as [compressed flag][u32 length][bytes].
const prefix = Buffer.alloc(5);
prefix.writeUInt32BE(format.length, 1);
call.end(Buffer.concat([prefix, Buffer.from(format)]));
call.on("error", () => process.exit(1));
call.on("close", () => process.exit(0));

let pending = Buffer.alloc(0);
call.on("data", (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  while (pending.length >= 5) {
    const len = pending.readUInt32BE(1);
    if (pending.length < 5 + len) break;
    const png = imageBytes(pending.subarray(5, 5 + len));
    pending = pending.subarray(5 + len);
    // An inactive display sends empty images.
    if (!png?.length) continue;
    // A still screen keeps sending the same picture: skip it, so nothing downstream
    // writes, reloads or redraws a frame that didn't change.
    if (last?.equals(png)) continue;
    last = Buffer.from(png);
    for (const socket of viewers) send(socket, last);
  }
});

// One write per frame. A viewer that can't keep up skips frames instead of
// queueing them, so it always gets the newest picture.
function send(socket, png) {
  if (socket.writableLength > 0) return;
  socket.write(Buffer.concat([Buffer.from(`--frame\r\nContent-Type: image/png\r\nContent-Length: ${png.length}\r\n\r\n`), png, Buffer.from("\r\n")]));
}

// Raw sockets, not node:http: http's chunked transfer encoding puts chunk sizes
// between the bytes, and the mod reads the multipart body as it comes.
const HEAD = "HTTP/1.1 200 OK\r\nContent-Type: multipart/x-mixed-replace; boundary=frame\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n";
net.createServer((socket) => {
  socket.setNoDelay(true);
  socket.on("error", () => socket.destroy());
  // Answer once the request has arrived; its contents don't matter.
  socket.once("data", () => {
    socket.write(HEAD);
    viewers.add(socket);
    if (last) send(socket, last);
    clearTimeout(idle);
    idle = null;
  });
  socket.on("close", () => {
    viewers.delete(socket);
    if (!viewers.size) stopSoon();
  });
}).listen(Number(listenPort), "127.0.0.1", stopSoon);
