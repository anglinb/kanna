import type { RegisteredPanel } from "../panel/types";
import type { RegisteredSeparator } from "../separator/types";

// The framework-free part of react-resizable-panels 4.12.2's
// lib/components/group/types.ts (the React props are dropped).

/**
 * Panel group orientation loosely relates to the `aria-orientation` attribute.
 * It determines how panels are are laid out within the group group and the direction they can be resized in.
 */
export type Orientation = "horizontal" | "vertical";

/**
 * Map of Panel id to flexGrow value;
 */
export type Layout = {
  [id: string]: number;
};

export type ResizeTargetMinimumSize = {
  coarse: number;
  fine: number;
};

export type RegisteredGroup = Readonly<{
  disabled: boolean;
  element: HTMLElement;
  id: string;
  mutableState: {
    defaultLayout: Readonly<Layout> | undefined;
    disableCursor: boolean;
    expandedPanelSizes: {
      [panelId: string]: number;
    };
    layouts: {
      [panelIds: string]: Layout;
    };
  };
  orientation: Orientation;
  panels: RegisteredPanel[];
  resizeTargetMinimumSize: ResizeTargetMinimumSize;
  separators: RegisteredSeparator[];
}>;

export interface GroupImperativeHandle {
  getLayout: () => { [panelId: string]: number };
  setLayout: (layout: { [panelId: string]: number }) => Layout;
}
