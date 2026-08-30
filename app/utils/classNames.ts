/**
 * Copyright (c) 2018 Jed Watson.
 * Licensed under the MIT License (MIT), see:
 *
 * @link http://jedwatson.github.io/classnames
 */

type ClassNamesArg = undefined | string | Record<string, boolean> | ClassNamesArg[];

export function classNames(...args: ClassNamesArg[]): string {
  return args.map(parseValue).filter(Boolean).join(' ');
}

function parseValue(arg: ClassNamesArg) {
  if (typeof arg === 'string') {
    return arg;
  }

  if (typeof arg !== 'object') {
    return '';
  }

  if (Array.isArray(arg)) {
    return classNames(...arg);
  }

  const classes: string[] = [];

  for (const key in arg) {
    if (arg[key]) {
      classes.push(key);
    }
  }

  return classes.join(' ');
}
