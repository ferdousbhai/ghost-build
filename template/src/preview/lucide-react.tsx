import { forwardRef, type SVGProps } from "react";

type PreviewIconProps = SVGProps<SVGSVGElement> & {
  size?: number | string;
  strokeWidth?: number | string;
};

export function createPreviewIcon(name: string) {
  const PreviewIcon = forwardRef<SVGSVGElement, PreviewIconProps>(
    ({ size = 24, strokeWidth = 2, children, ...props }, ref) => (
      <svg
        ref={ref}
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden={props["aria-label"] ? undefined : true}
        data-lucide={name}
        {...props}
      >
        <path d={previewIconPath(name)} />
        {children}
      </svg>
    ),
  );
  PreviewIcon.displayName = name;
  return PreviewIcon;
}

function previewIconPath(name: string) {
  switch (name) {
    case "Minus":
      return "M5 12h14";
    case "Plus":
      return "M12 5v14M5 12h14";
    case "RotateCcw":
      return "M3 12a9 9 0 1 0 3-6.7L3 8m0 0V3m0 5h5";
    case "Activity":
      return "M3 12h4l2-7 4 14 2-7h6";
    default:
      return "M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4";
  }
}
