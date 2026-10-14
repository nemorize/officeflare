// CSS Tree's smaller entry points expose the same typed functions as its main module.
declare module "css-tree/parser" {
  const parse: typeof import("css-tree").parse;
  export default parse;
}
declare module "css-tree/generator" {
  const generate: typeof import("css-tree").generate;
  export default generate;
}
declare module "css-tree/walker" {
  const walk: typeof import("css-tree").walk;
  export default walk;
}
