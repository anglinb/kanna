// The framework-free part of react-resizable-panels 4.12.2's
// lib/components/panel/types.ts (the React props are dropped).

export type PanelSize = {
  asPercentage: number;
  inPixels: number;
};

export type GroupResizeBehavior =
  | "preserve-relative-size"
  | "preserve-pixel-size";

/**
 * Numeric Panel constraints are represented as numeric percentages (0..100)
 * Values specified using other CSS units must be pre-converted.
 */
export type PanelConstraints = {
  collapsedSize: number;
  collapsible: boolean;
  defaultSize: number | undefined;
  disabled: boolean | undefined;
  groupResizeBehavior?: GroupResizeBehavior | undefined;
  maxSize: number;
  minSize: number;
  panelId: string;
};

export type SizeUnit = "px" | "%" | "em" | "rem" | "vh" | "vw";

export type OnPanelResize =
  | ((panelSize: PanelSize, id: string | number | undefined, prevPanelSize: PanelSize | undefined) => void)
  | undefined;

export type RegisteredPanel = {
  id: string;
  idIsStable: boolean;
  element: HTMLDivElement;
  mutableValues: {
    expandToSize: number | undefined;
    prevSize: PanelSize | undefined;
  };
  onResize: OnPanelResize | undefined;
  panelConstraints: PanelConstraintProps;
};

export interface PanelImperativeHandle {
  collapse: () => void;
  expand: () => void;
  getSize: () => {
    asPercentage: number;
    inPixels: number;
  };
  isCollapsed: () => boolean;
  resize: (size: number | string) => void;
}

/**
 * Size constraints may be specified in a variety of ways:
 * - Percentage of the parent Group (0..100)
 * - Pixels
 * - Relative font units (em, rem)
 * - Viewport relative units (vh, vw)
 *
 * Numeric values are assumed to be pixels.
 * Strings without explicit units are assumed to be percentages (0%..100%).
 */
export type PanelConstraintProps = {
  collapsedSize?: number | string | undefined;
  collapsible?: boolean | undefined;
  defaultSize?: number | string | undefined;
  disabled?: boolean | undefined;
  groupResizeBehavior?: GroupResizeBehavior | undefined;
  maxSize?: number | string | undefined;
  minSize?: number | string | undefined;
};
