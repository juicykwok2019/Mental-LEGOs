// The worker entry ships without type declarations; importing it only has the
// side effect of assigning globalThis.pdfjsWorker (see material-file.ts).
declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs';
