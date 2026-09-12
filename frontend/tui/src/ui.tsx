import { createContext, useContext, type ComponentProps, type ReactNode } from "react";
import { Box, Text as InkText } from "ink";
import { C, type Palette, type ThemeColor } from "./theme.ts";

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

export const Line = (props: ComponentProps<typeof Text>): ReactNode => (
  <Text wrap="truncate-end" {...props} />
);

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
}: {
  label: ReactNode;
  children: ReactNode;
  width?: number;
  suffix?: ReactNode;
}): ReactNode => (
  <Box>
    <Box width={width} flexShrink={0}>
      <Line tone="dim">{label}</Line>
    </Box>
    <Box flexGrow={1}>{children}</Box>
    {suffix != null && <Box flexShrink={0}>{suffix}</Box>}
  </Box>
);

/** A group of values sharing one label width. Null values omit the row. */
export const Fields = ({
  rows,
  width = 15,
}: {
  rows: readonly (readonly [string, ReactNode])[];
  width?: number;
}): ReactNode => (
  <>
    {rows.map(([label, value]) =>
      value == null ? null : (
        <Field key={label} width={width} label={<Line tone="faint">{label}</Line>}>
          <Line tone="dim" wrap="wrap">
            {value}
          </Line>
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
