// Ambient module declarations for static asset imports embedded into the
// Bun-compiled binary via `import x from "./foo.ext" with { type: "file" }`.
// Bun resolves these at compile time; tsc just needs to know the import
// shape so type-checking succeeds.
declare module "*.tgz" {
  const path: string;
  export default path;
}

declare module "*.sql" {
  const path: string;
  export default path;
}
