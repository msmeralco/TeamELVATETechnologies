// Vercel serverless entry point: re-exports the Express app as-is. Vercel's
// Node.js runtime invokes a default-exported Express app directly (it's a
// plain (req, res) => ... handler under the hood, same as http.createServer(app)).
// vercel.json rewrites /api/* here while leaving req.url as the original
// path, so Express's own /api/v1 router still matches normally.
//
// server.js detects process.env.VERCEL (set automatically by the platform)
// and skips app.listen() in that case, since a serverless function must not
// hold a port open.
export { default } from '../backend/src/server.js';
