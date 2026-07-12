module.exports = function shellSafeCommonJs(source) {
  const encoded = Buffer.from(source).toString('base64');
  const wrapper = `const source=Buffer.from("${encoded}","base64").toString("utf8");Function("require","module","exports","__filename","__dirname",source)(require,module,exports,__filename,__dirname);`;

  if (wrapper.includes("'")) {
    throw new Error('The shell-safe CommonJS wrapper must not contain single quotes.');
  }

  return wrapper;
};
