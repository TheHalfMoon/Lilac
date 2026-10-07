import { inflateSync } from "node:zlib";

// Just enough PNG reading for a test to check a painted colour: the first pixel of an
// 8-bit RGB or RGBA screenshot. For the first pixel of the first row every PNG filter
// leaves the bytes unchanged (their predictors are all zero there).
export const PNG = {
  firstPixel(buffer) {
    let offset = 8;
    let colorType = null;
    const data = [];
    while (offset < buffer.length) {
      const length = buffer.readUInt32BE(offset);
      const type = buffer.toString("ascii", offset + 4, offset + 8);
      const body = buffer.subarray(offset + 8, offset + 8 + length);
      if (type === "IHDR") {
        if (body[8] !== 8) throw new Error("only 8-bit PNGs are read");
        colorType = body[9];
      } else if (type === "IDAT") data.push(body);
      else if (type === "IEND") break;
      offset += 12 + length;
    }
    if (colorType !== 2 && colorType !== 6) throw new Error(`unsupported PNG colour type ${colorType}`);
    const pixels = inflateSync(Buffer.concat(data));
    return [pixels[1], pixels[2], pixels[3]];
  },
};
