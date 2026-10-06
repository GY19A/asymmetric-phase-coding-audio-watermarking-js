/**
 * Palette and color maps, from the UCLA brand palette (brand.ucla.edu/identity/colors).
 * Blue is the field, gold the accent. Bits: 1 = UCLA Blue, 0 = Darkest Gold. The accept state
 * uses Darker Blue; red is reserved for errors and rejections.
 * @module ui/colors
 */

import { interpolateRgb, piecewise, rgb } from 'd3';

/** Official UCLA swatches (HEX from the brand site). */
export const UCLA = Object.freeze({
  blue: '#2774AE',
  gold: '#FFD100',
  white: '#FFFFFF',
  darkestBlue: '#003B5C',
  darkerBlue: '#005587',
  lighterBlue: '#8BB8E8',
  lightestBlue: '#DAEBFE',
  darkestGold: '#FFB81C',
  darkerGold: '#FFC72C',
  black: '#000000',
});

export const C = Object.freeze({
  bg: UCLA.white,
  surface: UCLA.white,
  line: '#D9D9D9',
  line2: '#BFBFBF',
  grid: '#EDEDED',
  text: '#1A1A1A',
  soft: '#404040',
  muted: '#595959',
  faint: '#6E6E6E',
  blue: UCLA.blue,
  darkerBlue: UCLA.darkerBlue,
  darkestBlue: UCLA.darkestBlue,
  lighterBlue: UCLA.lighterBlue,
  gold: UCLA.gold,
  darkestGold: UCLA.darkestGold,
  bad: '#C8102E',
  ok: UCLA.darkerBlue,
  bit1: UCLA.blue,
  bit0: UCLA.darkestGold,
});

/** Brand blue gradient (Darker Blue, UCLA Blue, Lighter Blue), piecewise linear, t in [0, 1]. */
export const signal = piecewise(interpolateRgb, [UCLA.darkerBlue, UCLA.blue, UCLA.lighterBlue]);

export const bitColor = (b) => (b ? C.bit1 : C.bit0);

/** 256-entry RGBA lookup table of a color function. */
export function lut(f) {
  const t = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    const c = rgb(f(i / 255));
    t[4 * i] = c.r;
    t[4 * i + 1] = c.g;
    t[4 * i + 2] = c.b;
    t[4 * i + 3] = 255;
  }
  return t;
}

/** Spectrogram map through the official blues, piecewise linear: white (quiet) to Darkest Blue (loud). */
export const LEVEL = lut(piecewise(interpolateRgb, ['#FFFFFF', UCLA.lightestBlue, UCLA.lighterBlue, UCLA.blue, UCLA.darkerBlue, UCLA.darkestBlue]));

/** Diverging map, piecewise linear: Darkest Gold (negative), exact white at zero, Darker Blue (positive). */
export const DIVERGING = lut(piecewise(interpolateRgb, [UCLA.darkestGold, UCLA.darkerGold, '#FFFFFF', UCLA.lighterBlue, UCLA.darkerBlue]));
