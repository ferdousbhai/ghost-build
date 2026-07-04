/**
 * Copyright (c) 2018 Jed Watson.
 * Licensed under the MIT License (MIT), see:
 *
 * @link http://jedwatson.github.io/classnames
 */

type ClassNamesArg = undefined | string | Record<string, boolean> | ClassNamesArg[];

/**
 * A simple JavaScript utility for conditionally joining classNames together.
 *
 * @param args A series of classes or object with key that are class and values
 * that are interpreted as boolean to decide whether or not the class
 * should be included in the final class.
 */
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
