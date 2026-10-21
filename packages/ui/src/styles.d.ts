/**
 * What a bundler states about the stylesheets this package imports.
 *
 * A CSS module answers a record of the class names it declares, which is all `ChatMinimap` reads. A plain stylesheet
 * answers nothing: the host imports it for its side effect. Both declarations exist here, in the package that owns the
 * files, so a host's bundler is not what makes this package typecheck.
 */
declare module "*.module.css" {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}

declare module "*.css";
