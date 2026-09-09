export const MONTAGE_PRESENTATION = {
  raw: { equation: "yᵢ = xᵢ", description: "Keep the original channel reference." },
  bipolar: { equation: "yᵢ = xᵢ − xᵢ₊₁", description: "Subtract adjacent channels within each group." },
  car: { equation: "yᵢ = xᵢ − mean(x)", description: "Subtract the average of all channels." },
  "group-car": { equation: "yᵢ = xᵢ − mean(group)", description: "Subtract the average within each channel group." },
  local: { equation: "yᵢ = xᵢ − mean(neighbors)", description: "Subtract adjacent neighbors in the same group." },
};

export function recordingReadout(header) {
  const number = (v, suffix) => Number.isFinite(Number(v)) && v != null
    ? `${Number(Number(v).toFixed(2))}${suffix}` : "—";
  return {
    file: header.fileName || "Recording",
    format: String(header.kind || "Signal").toUpperCase(),
    channels: number(header.nChannels, ""),
    rate: number(header.fs, " Hz"),
    duration: number(header.durationSec, " s"),
  };
}
