/** Editable captions and SRT/VTT text. Speech recognition is not bundled. */

export function cuesFromScript(text, duration) {
  const words = String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length || !(duration > 0)) return [];
  const slice = duration / words.length;
  const wordsTimed = words.map((word, index) => ({
    text: word,
    start: index * slice,
    end: (index + 1) * slice,
  }));
  const cues = [];
  for (let i = 0; i < wordsTimed.length; i += 6) {
    const group = wordsTimed.slice(i, i + 6);
    cues.push({
      start: group[0].start,
      end: group[group.length - 1].end,
      text: group.map((word) => word.text).join(" "),
      words: group,
    });
  }
  return cues;
}

function stamp(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const milli = ms % 1000;
  const pad = (value, n = 2) => String(value).padStart(n, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(milli, 3)}`;
}

export function toSrt(cues) {
  return (cues || [])
    .map((cue, index) => `${index + 1}\n${stamp(cue.start)} --> ${stamp(cue.end)}\n${cue.text}\n`)
    .join("\n");
}

export function toVtt(cues) {
  const body = (cues || [])
    .map((cue) => `${stamp(cue.start).replace(",", ".")} --> ${stamp(cue.end).replace(",", ".")}\n${cue.text}\n`)
    .join("\n");
  return `WEBVTT\n\n${body}`;
}

export function parseSrt(text) {
  const blocks = String(text || "").replace(/\r/g, "").split(/\n\s*\n/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split("\n").filter((line) => line.trim());
    const timeLine = lines.find((line) => line.includes("-->"));
    if (!timeLine) continue;
    const [start, end] = timeLine.split("-->").map((part) => {
      const match = part.trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
      if (!match) return 0;
      return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
    });
    const wordsStart = lines.indexOf(timeLine) + 1;
    const caption = lines.slice(wordsStart).join(" ").trim();
    if (!caption) continue;
    const wordTexts = caption.split(/\s+/);
    const slice = (end - start) / wordTexts.length;
    cues.push({
      start,
      end,
      text: caption,
      words: wordTexts.map((word, index) => ({
        text: word,
        start: start + index * slice,
        end: start + (index + 1) * slice,
      })),
    });
  }
  return cues;
}

export function cueAt(cues, time) {
  return (cues || []).find((cue) => time >= cue.start && time < cue.end) || null;
}
