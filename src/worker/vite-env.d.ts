// Vite defines import.meta.env in every environment, including the Worker.
interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly MODE: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Vite's ?raw imports: a file's text as a string (the tracker script).
declare module "*?raw" {
  const text: string;
  export default text;
}
