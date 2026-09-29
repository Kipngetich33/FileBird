/**
 * The FileBird bird — a swallow, facing right, in a 120 × 80 box. Drawn by the
 * start screen (as the logo and as the bird that flies along the stream);
 * resources/icon.svg uses the same shapes.
 */
export const BIRD_SIZE = { width: 120, height: 80 }

/** Head, beak, body and the long forked tail. */
export const BIRD_BODY =
  'M117 35 L106 32.5 C104 27 97.5 24.5 91.5 25.5 C86 26.5 82.5 29.5 80.5 33 C72 36 60 39.5 48 43.5 L4 34 L41 47.5 L3 57 L45 51.5 C60 55 78 53.5 91 48 C98 45 103 42 106.5 38.5 Z'

/** The far wing, behind the body. */
export const BIRD_FAR_WING = 'M78 45 C70 55 57 65 37 74 C49 63 58 55 62 49 Z'

/** The near wing, swept up and back, as two layered, feathered blades. */
export const BIRD_NEAR_WING =
  'M83 35 C75 20 59 8 28 2 C37 8 43 13 47 17.5 C40 16.5 33 16.5 27 17.5 C43 24 56 32 64 41.5 Z'
export const BIRD_NEAR_WING_INNER = 'M77 38 C65 30 51 25 26 25 C40 30 52 37 58 44 Z'

export const BIRD_EYE = { x: 99.5, y: 31, radius: 1.9 }

/** Where the wings meet the body; they beat about this point. */
export const BIRD_SHOULDER = { x: 79, y: 39 }
