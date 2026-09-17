import { type ComponentProps, createContext, type ReactNode, useContext } from "react";
import { Box, Text as InkText } from "ink";
import { C, type Palette, type ThemeColor } from "./theme.ts";
import type { TextSpan } from "./text-layout.ts";

export const PaletteContext = createContext(C);
export const useTheme = (): Palette => useContext(PaletteContext);

/** Semantic colours resolve at render time, including inside prepared layouts. */
export const Text = ({
  tone,
  ...props
}: ComponentProps<typeof InkText> & { tone?: ThemeColor }): ReactNode => {
  const theme = useTheme();
  return <InkText {...(tone ? { color: theme[tone] } : {})} {...props} />;
};

/** The only Ink adapter for prepared document spans. Colours resolve per theme. */
export const StyledText = ({ spans }: { spans: readonly TextSpan[] }): ReactNode => {
  const palette = useTheme();
  const colors = {
    heading: palette.accent,
    code: palette.warn,
    link: palette.accent,
    muted: palette.dim,
    faint: palette.faint,
    keyword: palette.accent,
    string: palette.good,
    number: palette.await_,
  };
  return spans.map((span, i) => (
    <InkText
      key={i}
      bold={span.bold ?? false}
      italic={span.italic ?? false}
      underline={span.underline ?? false}
      strikethrough={span.strikethrough ?? false}
      {...(span.role ? { color: colors[span.role] } : {})}
      {...(span.background ? { backgroundColor: palette.codeBg } : {})}
    >
      {span.text}
    </InkText>
  ));
};

export const Line = (props: ComponentProps<typeof Text>): ReactNode => (
  <Text wrap="truncate-end" {...props} />
);

/** Prepared text rows, including blank rows; wrapping belongs to the caller. */
export const Lines = ({
  lines,
  ...props
}: Omit<ComponentProps<typeof Line>, "children"> & {
  lines: readonly string[];
}): ReactNode =>
  lines.length ? <Line {...props}>{lines.map((line) => line || " ").join("\n")}</Line> : null;

/** Pane chrome. Overlays use the same panel with roomier padding. */
export const Panel = ({
  tone = "faint",
  title,
  overlay = false,
  children,
  ...props
}: ComponentProps<typeof Box> & {
  tone?: ThemeColor;
  title?: ReactNode;
  overlay?: boolean;
}): ReactNode => {
  const theme = useTheme();
  return (
    <Box
      borderStyle="round"
      borderColor={theme[tone]}
      borderBackgroundColor={theme.bg}
      paddingX={overlay ? 2 : 1}
      paddingY={overlay ? 1 : 0}
      flexDirection="column"
      {...props}
    >
      {title != null && (
        <Line tone={tone} bold>
          {title}
        </Line>
      )}
      {children}
    </Box>
  );
};

/** Fixed label gutter with a flexible value and optional right-aligned suffix. */
export const Field = ({
  label,
  children,
  width = 8,
  suffix,
  labelTone = "dim",
  ...props
}: ComponentProps<typeof Line> & {
  label: ReactNode;
  children: ReactNode;
  width?: number;
  suffix?: ReactNode;
  labelTone?: ThemeColor;
}): ReactNode => (
  <Box>
    <Box width={width} flexShrink={0}>
      <Line tone={labelTone}>{label}</Line>
    </Box>
    <Box flexGrow={1}>
      <Line {...props}>{children}</Line>
    </Box>
    {suffix != null && <Box flexShrink={0}>{suffix}</Box>}
  </Box>
);

/** A group of values sharing one label width. Null values omit the row. */
export const Fields = ({
  rows,
  ...props
}: Omit<ComponentProps<typeof Field>, "label" | "children"> & {
  rows: readonly (readonly [ReactNode, ReactNode])[];
}): ReactNode => (
  <>
    {rows.map(([label, value], i) =>
      value == null ? null : (
        <Field key={i} width={15} label={label} labelTone="faint" tone="dim" wrap="wrap" {...props}>
          {value}
        </Field>
      ),
    )}
  </>
);

export const Section = ({ title, children }: { title: string; children: ReactNode }): ReactNode => (
  <>
    <Box height={1} />
    <Line tone="dim" bold>
      {title}
    </Line>
    {children}
  </>
);

export const Hints = ({
  items,
  gap = 1,
}: {
  items: readonly { keys: string; label: string }[];
  gap?: number;
}): ReactNode => (
  <Line>
    {items.map(({ keys, label }, i) => (
      <Text key={keys}>
        {i > 0 && <Text tone="faint">{" ".repeat(gap) + "·" + " ".repeat(gap)}</Text>}
        <Text tone="accent">{keys}</Text>
        <Text tone="dim">{" ".repeat(gap) + label}</Text>
      </Text>
    ))}
  </Line>
);

/** Shared placement and opaque surface for floating TUI dialogs. */
export const modalWidth = (cols: number): number =>
  Math.max(1, Math.min(96, cols - (cols >= 44 ? 8 : 0)));

export const modalPosition = (cols: number, rows: number, width: number, height: number) => ({
  left: Math.max(0, Math.floor((cols - width) / 2)),
  top: Math.max(0, Math.floor((rows - height) / 3)),
});

export const FloatingLayer = ({
  left,
  top,
  width,
  height,
  children,
}: {
  left: number;
  top: number;
  width: number;
  height: number;
  children: ReactNode;
}): ReactNode => {
  const theme = useTheme();
  return (
    <>
      {/* Paint spaces explicitly: background colour alone leaves text visible in NO_COLOR. */}
      <Box position="absolute" left={left} top={top} width={width} height={height}>
        <Text {...(theme.bg ? { backgroundColor: theme.bg } : {})}>
          {Array.from({ length: height }, () => " ".repeat(width)).join("\n")}
        </Text>
      </Box>
      <Box
        position="absolute"
        left={left}
        top={top}
        width={width}
        height={height}
        flexDirection="column"
        overflow="hidden"
        backgroundColor={theme.bg}
      >
        {children}
      </Box>
    </>
  );
};
