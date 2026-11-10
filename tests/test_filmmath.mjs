import assert from "node:assert/strict";
import test from "node:test";

import {
  FPS,
  LETTERBOX_RATIO,
  PRESETS,
  RESOLUTIONS,
  buildTimeline,
  layersAt,
  letterboxRect,
  outputSize,
  workSize,
} from "../web/src/filmmath.mjs";

test("every export is at least 720p and 4K is a 1080p working picture", () => {
  for (const [id, item] of Object.entries(RESOLUTIONS)) {
    const size = outputSize(id);
    assert.ok(size.width >= 1280);
    assert.ok(size.height >= 720);
    assert.equal(size.width, item.width);
  }
  assert.deepEqual(
    [workSize("720", false).workWidth, workSize("720", false).workHeight],
    [1280, 720],
  );
  assert.deepEqual(
    [workSize("1080", false).workWidth, workSize("1080", false).workHeight],
    [1920, 1080],
  );
  assert.deepEqual(
    [workSize("2160", false).workWidth, workSize("2160", false).workHeight],
    [1920, 1080],
  );
});

test("letterbox is about 2.39:1 inside a 720p frame", () => {
  const box = letterboxRect(1280, 720, true);
  assert.ok(box.bar > 40);
  const ratio = box.width / box.height;
  assert.ok(Math.abs(ratio - LETTERBOX_RATIO) < 0.03);
  assert.equal(letterboxRect(1280, 720, false).bar, 0);
});

test("looks and a multi-clip timeline with slow motion and trimming", () => {
  for (const id of ["movie", "vintage", "dramatic", "clean"]) assert.ok(PRESETS[id]);
  assert.equal(PRESETS.movie.letterbox, true);
  assert.equal(PRESETS.clean.enhance, true);
  const video = { id: "v", kind: "video", duration: 2, width: 640, height: 360 };
  const photo = { id: "p", kind: "image", duration: 0, width: 800, height: 600 };
  const timeline = buildTimeline([video, photo], { slowMo: 1, resolution: "720", enhance: false });
  assert.equal(timeline.error, undefined);
  assert.ok(Math.abs(timeline.duration - (2 + 3 - 0.45)) < 0.001);
  assert.equal(timeline.frameCount, Math.round(timeline.duration * FPS));
  assert.equal(layersAt(timeline, 0).length, 1);
  const overlap = layersAt(timeline, 1.8);
  assert.equal(overlap.length, 2);
  assert.ok(overlap[1].alpha > 0.2 && overlap[1].alpha < 0.8);

  const slow = buildTimeline([video], { slowMo: 2, resolution: "720", enhance: false });
  assert.ok(Math.abs(slow.duration - 4) < 0.001);
  assert.equal(slow.segments[0].sourceUsed, 2);

  const long = buildTimeline([{ ...video, duration: 30, id: "long" }], {
    slowMo: 1,
    resolution: "720",
    enhance: true,
  });
  assert.equal(long.trimmed, true);
  assert.ok(long.duration <= 8.01);
  assert.ok(long.message.includes("opening"));
});
