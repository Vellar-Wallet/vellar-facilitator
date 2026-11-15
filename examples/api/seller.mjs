// Vercel function entry for the demo seller. Vercel treats every file in api/ as a
// function and calls its default export per request; the Express app is that
// handler. All behaviour lives in ../seller.mjs, which skips app.listen() when
// process.env.VERCEL is set. vercel.json rewrites every path here.
export { default } from "../seller.mjs";
