/* eslint-disable react-refresh/only-export-components -- preview compatibility module exports the router API shape */

import type { AnchorHTMLAttributes, ComponentType } from "react";

type PreviewRouteOptions = {
  component?: ComponentType;
};

export function createFileRoute(_path: string) {
  return <T extends PreviewRouteOptions>(options: T) => ({ options });
}

export function useHydrated() {
  return true;
}

export function Link({
  to,
  children,
  ...props
}: {
  to: string;
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  return (
    <a href={to} {...props}>
      {children}
    </a>
  );
}

export function useNavigate() {
  return ({ to }: { to: string }) => {
    window.location.assign(to);
  };
}
