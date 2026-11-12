import type { SVGProps } from "react";

/**
 * Cube's own icon set. Every glyph sits on a 20px grid with a 1.75 stroke and
 * rounded joins, so they read as one family next to the cube characters.
 */
function Svg({ children, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      {children}
    </svg>
  );
}

type P = SVGProps<SVGSVGElement>;

export const HashIcon = (p: P) => <Svg {...p}><path d="M7.5 3.5 6 16.5M14 3.5l-1.5 13M3.5 7.5h13M3 12.5h13" /></Svg>;
export const PlusIcon = (p: P) => <Svg {...p}><path d="M10 4v12M4 10h12" /></Svg>;
export const SearchIcon = (p: P) => <Svg {...p}><circle cx="9" cy="9" r="5.25" /><path d="m13 13 3.5 3.5" /></Svg>;
export const SendIcon = (p: P) => <Svg {...p}><path d="M10 16V4.5M5 9l5-5 5 5" /></Svg>;
export const StopIcon = (p: P) => <Svg {...p}><rect x="5.5" y="5.5" width="9" height="9" rx="2.25" fill="currentColor" stroke="none" /></Svg>;
export const ThreadIcon = (p: P) => <Svg {...p}><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h7A2.5 2.5 0 0 1 16 5.5v5a2.5 2.5 0 0 1-2.5 2.5H10l-4 3.5V13h-.5A1.5 1.5 0 0 1 4 11.5z" /></Svg>;
export const SmileIcon = (p: P) => <Svg {...p}><circle cx="10" cy="10" r="6.75" /><path d="M7.25 11.5c.6 1 1.6 1.5 2.75 1.5s2.15-.5 2.75-1.5" /><path d="M7.75 8h.01M12.25 8h.01" strokeWidth="2.4" /></Svg>;
export const CopyIcon = (p: P) => <Svg {...p}><rect x="7" y="7" width="9.5" height="9.5" rx="2.25" /><path d="M4.75 12.5A1.75 1.75 0 0 1 3.5 10.8V5.75A2.25 2.25 0 0 1 5.75 3.5h5.05c.8 0 1.5.5 1.7 1.25" /></Svg>;
export const TrashIcon = (p: P) => <Svg {...p}><path d="M4 5.5h12M8 5.5V4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5M5.5 5.5l.6 9.3A1.5 1.5 0 0 0 7.6 16.2h4.8a1.5 1.5 0 0 0 1.5-1.4l.6-9.3" /></Svg>;
export const CloseIcon = (p: P) => <Svg {...p}><path d="m5 5 10 10M15 5 5 15" /></Svg>;
export const StageIcon = (p: P) => <Svg {...p}><rect x="3" y="4" width="14" height="10" rx="2.5" /><path d="M7.5 17h5" /></Svg>;
export const OpenIcon = (p: P) => <Svg {...p}><path d="M11.5 3.5h5v5M16.5 3.5 9.5 10.5M8 4.5H6A2.5 2.5 0 0 0 3.5 7v7A2.5 2.5 0 0 0 6 16.5h7a2.5 2.5 0 0 0 2.5-2.5v-2" /></Svg>;
export const ChevronIcon = (p: P) => <Svg {...p}><path d="m7.5 5 5 5-5 5" /></Svg>;
export const AtIcon = (p: P) => <Svg {...p}><circle cx="10" cy="10" r="2.75" /><path d="M12.75 7.5v3.25a1.9 1.9 0 0 0 3.75 0V10a6.5 6.5 0 1 0-2.6 5.2" /></Svg>;
export const HomeIcon = (p: P) => <Svg {...p}><path d="M3.5 9.5 10 4l6.5 5.5V15a1.5 1.5 0 0 1-1.5 1.5h-2.5v-4h-5v4H5A1.5 1.5 0 0 1 3.5 15z" /></Svg>;
export const GearIcon = (p: P) => <Svg {...p}><path d="M8.67 4.46 L9.01 2.67 L10.99 2.67 L11.33 4.46 L12.98 5.14 L14.49 4.12 L15.88 5.51 L14.86 7.02 L15.54 8.67 L17.33 9.01 L17.33 10.99 L15.54 11.33 L14.86 12.98 L15.88 14.49 L14.49 15.88 L12.98 14.86 L11.33 15.54 L10.99 17.33 L9.01 17.33 L8.67 15.54 L7.02 14.86 L5.51 15.88 L4.12 14.49 L5.14 12.98 L4.46 11.33 L2.67 10.99 L2.67 9.01 L4.46 8.67 L5.14 7.02 L4.12 5.51 L5.51 4.12 L7.02 5.14Z" /><circle cx="10" cy="10" r="2.4" /></Svg>;
export const PanelIcon = (p: P) => <Svg {...p}><rect x="3" y="4" width="14" height="12" rx="2.5" /><path d="M8 4v12" /></Svg>;
export const PencilIcon = (p: P) => <Svg {...p}><path d="m4 16 .6-3.2 8.3-8.3a1.6 1.6 0 0 1 2.3 0l.3.3a1.6 1.6 0 0 1 0 2.3L7.2 15.4z" /><path d="m11.5 6 2.5 2.5" /></Svg>;
export const TermIcon = (p: P) => <Svg {...p}><rect x="3" y="4" width="14" height="12" rx="2.5" /><path d="m6.5 8.5 2 1.75-2 1.75M10.5 12.5h3" /></Svg>;
export const RewindIcon = (p: P) => <Svg {...p}><path d="M4 10a6 6 0 1 0 1.9-4.4" /><path d="M4 4.5v3.2h3.2" /><path d="M10 7v3.2l2 1.3" /></Svg>;
export const CheckIcon = (p: P) => <Svg {...p}><path d="m4.5 10.5 3.5 3.5 7.5-8" /></Svg>;
export const PinIcon = (p: P) => <Svg {...p}><path d="m12 3.5 4.5 4.5-2 .7-2.6 2.6.3 3.2-1.4 1.4-6.7-6.7 1.4-1.4 3.2.3 2.6-2.6z" /><path d="m7.4 12.6-3.9 3.9" /></Svg>;
export const ClipIcon = (p: P) => <Svg {...p}><path d="m15.5 9.5-5.6 5.6a3.2 3.2 0 0 1-4.5-4.5l6-6a2.1 2.1 0 0 1 3 3l-6 6a1.05 1.05 0 0 1-1.5-1.5l5.3-5.3" /></Svg>;
export const MicIcon = (p: P) => <Svg {...p}><rect x="7.5" y="3" width="5" height="8.5" rx="2.5" /><path d="M4.75 9.5a5.25 5.25 0 0 0 10.5 0M10 14.75V17" /></Svg>;
export const InboxIcon = (p: P) => <Svg {...p}><path d="M3.5 11.5 5.6 5a1.5 1.5 0 0 1 1.4-1h6a1.5 1.5 0 0 1 1.4 1l2.1 6.5V15a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 15z" /><path d="M3.5 11.5h3.75a2.75 2.75 0 0 0 5.5 0h3.75" /></Svg>;
export const ClockIcon = (p: P) => <Svg {...p}><circle cx="10" cy="10" r="6.75" /><path d="M10 6.25V10l2.5 1.75" /></Svg>;
export const GlobeIcon = (p: P) => <Svg {...p}><circle cx="10" cy="10" r="6.75" /><path d="M3.25 10h13.5M10 3.25c2 2.2 2.9 4.4 2.9 6.75s-.9 4.55-2.9 6.75c-2-2.2-2.9-4.4-2.9-6.75S8 5.45 10 3.25z" /></Svg>;
export const ReloadIcon = (p: P) => <Svg {...p}><path d="M16 10a6 6 0 1 1-1.9-4.4" /><path d="M16 4.5v3.2h-3.2" /></Svg>;
export const BackIcon = (p: P) => <Svg {...p}><path d="m12.5 5-5 5 5 5" /></Svg>;
export const CropIcon = (p: P) => <Svg {...p}><path d="M6 2.5V12a2 2 0 0 0 2 2h9.5M2.5 6H12a2 2 0 0 1 2 2v9.5" /></Svg>;
export const BranchIcon = (p: P) => <Svg {...p}><circle cx="6" cy="5" r="1.75" /><circle cx="6" cy="15" r="1.75" /><circle cx="14" cy="7" r="1.75" /><path d="M6 6.75v6.5M14 8.75c0 2.5-2 3.25-4 3.5S6 13 6 13.25" /></Svg>;
export const UserIcon = (p: P) => <Svg {...p}><circle cx="10" cy="7" r="3" /><path d="M4 16.5c.6-3 3-4.5 6-4.5s5.4 1.5 6 4.5" /></Svg>;
export const CubeIcon = (p: P) => <Svg {...p}><path d="M10 2.75 16.25 6.25v7.5L10 17.25 3.75 13.75v-7.5L10 2.75Z" /><path d="M3.75 6.25 10 9.75l6.25-3.5M10 9.75v7.5" /></Svg>;
export const PlugIcon = (p: P) => <Svg {...p}><path d="M7.5 3v4M12.5 3v4M5.5 7h9v2.5a4.5 4.5 0 0 1-9 0V7ZM10 14v3" /></Svg>;
export const BookIcon = (p: P) => <Svg {...p}><path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H16v11.5H5.5A1.5 1.5 0 0 0 4 16V4.5ZM4 16a1.5 1.5 0 0 0 1.5 1.5H16M7.5 6.5h5" /></Svg>;
export const LockIcon = (p: P) => <Svg {...p}><rect x="4.5" y="9" width="11" height="7.5" rx="2" /><path d="M7 9V6.75a3 3 0 0 1 6 0V9" /></Svg>;
export const PeopleIcon = (p: P) => <Svg {...p}><circle cx="7.5" cy="7" r="2.5" /><path d="M2.75 16c.4-2.6 2.3-4 4.75-4s4.35 1.4 4.75 4" /><circle cx="14" cy="7.5" r="2" /><path d="M14.2 11.6c1.8.2 3 1.5 3.3 3.9" /></Svg>;
export const BellIcon = (p: P) => <Svg {...p}><path d="M5.5 13.5V9a4.5 4.5 0 0 1 9 0v4.5l1.25 1.5H4.25L5.5 13.5ZM8.5 17h3" /></Svg>;
export const DataIcon = (p: P) => <Svg {...p}><ellipse cx="10" cy="5.5" rx="5.5" ry="2.25" /><path d="M4.5 5.5v9c0 1.25 2.45 2.25 5.5 2.25s5.5-1 5.5-2.25v-9M4.5 10c0 1.25 2.45 2.25 5.5 2.25s5.5-1 5.5-2.25" /></Svg>;
