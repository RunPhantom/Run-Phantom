// Ambient module declarations for Vite-specific import suffixes.
// Lets Vite raw Markdown imports typecheck when app code needs them.
declare module "*.md?raw" {
  const content: string;
  export default content;
}

declare module "*.png" {
  const src: string;
  export default src;
}

declare module "*.svg" {
  const src: string;
  export default src;
}

declare const __APP_VERSION__: string;
