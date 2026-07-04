import { memo, type JSX as ReactJSX, type JSXElementConstructor } from 'react';

type PropsOf<T> = T extends keyof ReactJSX.IntrinsicElements
  ? ReactJSX.IntrinsicElements[T]
  : T extends JSXElementConstructor<infer Props>
    ? Props
    : never;

export const genericMemo: <T extends keyof ReactJSX.IntrinsicElements | JSXElementConstructor<never>>(
  component: T,
  propsAreEqual?: (prevProps: PropsOf<T>, nextProps: PropsOf<T>) => boolean,
) => T & { displayName?: string } = memo;
