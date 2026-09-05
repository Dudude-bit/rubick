//! ANSI escape sequences in a log line: taken out of the text, kept as
//! style runs.
//!
//! A program that colours its output writes SGR sequences into the same
//! bytes the parser has to read. Left in, they hide the level word from
//! the level parser, break the `{` a JSON line starts with, and reach the
//! reader as `[32mINFO[0m`. Taken out and thrown away, the colour the
//! program chose is lost. So the text is cleaned once here and the
//! styles ride alongside it as segments over the cleaned text.
//!
//! Only SGR (`CSI ... m`) becomes style. Every other escape the line
//! carries, cursor movement, charset selection, OSC titles and hyperlinks,
//! DCS payloads, is dropped: a log viewer is not a terminal, and none of
//! them mean anything in one. Framing follows ECMA-48, so a sequence a
//! program got wrong ends where the grammar says it ends and the text
//! after it is kept.

use std::borrow::Cow;

use serde::{Deserialize, Serialize};

/// A colour the way SGR names it. `Named` is the sixteen a palette
/// defines, so the frontend can pick a shade that reads on its canvas;
/// `Indexed` is the 256-colour cube and greys; `Rgb` is truecolor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum AnsiColor {
    Named { index: u8 },
    Indexed { index: u8 },
    Rgb { r: u8, g: u8, b: u8 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[allow(clippy::struct_excessive_bools)]
pub struct TextStyle {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fg: Option<AnsiColor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bg: Option<AnsiColor>,
    pub bold: bool,
    pub dim: bool,
    pub italic: bool,
    pub underline: bool,
    pub inverse: bool,
    pub strike: bool,
}

impl TextStyle {
    fn is_plain(self) -> bool {
        self == TextStyle::default()
    }
}

/// A run of the cleaned text drawn in one style. `style` is absent for
/// text the program left in the terminal's default.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StyledSegment {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<TextStyle>,
}

/// The cleaned text, and its style runs when the line carried any SGR.
/// `segments` is `None` for a line with no colour at all, which is most
/// lines, so the payload does not grow for them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Split {
    pub text: String,
    pub segments: Option<Vec<StyledSegment>>,
}

const ESC: char = '\u{1b}';
const BEL: char = '\u{07}';
const CSI_C1: char = '\u{9b}';
const OSC_C1: char = '\u{9d}';
const ST_C1: char = '\u{9c}';
const DCS_C1: char = '\u{90}';
const SOS_C1: char = '\u{98}';
const PM_C1: char = '\u{9e}';
const APC_C1: char = '\u{9f}';

fn is_introducer(c: char) -> bool {
    matches!(c, ESC | CSI_C1 | OSC_C1 | DCS_C1 | SOS_C1 | PM_C1 | APC_C1)
}

/// The text with every escape sequence taken out. Borrowed when there
/// was nothing to take out.
#[must_use]
pub fn strip(input: &str) -> Cow<'_, str> {
    if input.contains(is_introducer) {
        Cow::Owned(split_escaped(input).text)
    } else {
        Cow::Borrowed(input)
    }
}

enum Sequence {
    Csi,
    Osc,
    ControlString,
    Charset,
    Single,
}

/// Take the escapes out of `input`.
#[must_use]
pub fn split(input: &str) -> Split {
    if !input.contains(is_introducer) {
        return Split {
            text: input.to_string(),
            segments: None,
        };
    }
    split_escaped(input)
}

fn split_escaped(input: &str) -> Split {
    let chars: Vec<char> = input.chars().collect();
    let mut text = String::with_capacity(input.len());
    let mut runs: Vec<(usize, TextStyle)> = vec![(0, TextStyle::default())];
    let mut style = TextStyle::default();
    let mut i = 0;

    while i < chars.len() {
        let c = chars[i];
        let sequence = match c {
            ESC => match chars.get(i + 1) {
                Some('[') => Sequence::Csi,
                Some(']') => Sequence::Osc,
                Some('P' | 'X' | '^' | '_') => Sequence::ControlString,
                Some(' '..='/') => Sequence::Charset,
                Some(_) => Sequence::Single,
                None => break,
            },
            CSI_C1 => Sequence::Csi,
            OSC_C1 => Sequence::Osc,
            DCS_C1 | SOS_C1 | PM_C1 | APC_C1 => Sequence::ControlString,
            _ => {
                text.push(c);
                i += 1;
                continue;
            }
        };
        i += if c == ESC { 2 } else { 1 };

        match sequence {
            Sequence::Csi => {
                let start = i;
                while i < chars.len() && ('0'..='?').contains(&chars[i]) {
                    i += 1;
                }
                let params_end = i;
                while i < chars.len() && (' '..='/').contains(&chars[i]) {
                    i += 1;
                }
                let intermediates = i > params_end;
                // A byte the grammar does not allow ends the sequence and
                // is kept as text; so does the end of the line.
                match chars.get(i) {
                    Some(&f) if ('@'..='~').contains(&f) => {
                        i += 1;
                        let params: String = chars[start..params_end].iter().collect();
                        let private = params.starts_with(['<', '=', '>', '?']);
                        if f == 'm' && !intermediates && !private {
                            let next = apply_sgr(style, &params);
                            if next != style {
                                runs.push((text.len(), next));
                                style = next;
                            }
                        }
                    }
                    _ => {}
                }
            }
            Sequence::Osc | Sequence::ControlString => {
                let bel_ends = matches!(sequence, Sequence::Osc);
                while i < chars.len() {
                    match chars[i] {
                        ST_C1 => {
                            i += 1;
                            break;
                        }
                        BEL if bel_ends => {
                            i += 1;
                            break;
                        }
                        ESC if chars.get(i + 1) == Some(&'\\') => {
                            i += 2;
                            break;
                        }
                        _ => i += 1,
                    }
                }
            }
            Sequence::Charset => {
                while i < chars.len() && (' '..='/').contains(&chars[i]) {
                    i += 1;
                }
                if i < chars.len() && ('0'..='~').contains(&chars[i]) {
                    i += 1;
                }
            }
            Sequence::Single => {}
        }
    }

    runs.push((text.len(), TextStyle::default()));
    let segments: Vec<StyledSegment> = runs
        .windows(2)
        .filter(|w| w[1].0 > w[0].0)
        .map(|w| StyledSegment {
            text: text[w[0].0..w[1].0].to_string(),
            style: if w[0].1.is_plain() {
                None
            } else {
                Some(w[0].1)
            },
        })
        .collect();
    // A line whose only SGR was a no-op (`ESC[0m` hygiene, an unknown
    // code) reads like a plain one and pays like one.
    let segments = segments
        .iter()
        .any(|s| s.style.is_some())
        .then_some(segments);

    Split { text, segments }
}

/// The parameters of one SGR sequence applied to `style`.
///
/// `;` separates parameters and `:` sub-parameters, and a parameter with
/// sub-parameters is one command (`38:2::r:g:b`, `4:3`), not several.
/// A parameter that is not a number, or a code nobody defined, leaves
/// the style alone: a program that wrote `999` did not mean "reset".
fn apply_sgr(mut style: TextStyle, params: &str) -> TextStyle {
    if params.is_empty() {
        return TextStyle::default();
    }
    let params: Vec<Vec<Option<u16>>> = params
        .split(';')
        .map(|p| {
            p.split(':')
                .map(|s| {
                    if s.is_empty() {
                        Some(0)
                    } else {
                        s.parse().ok()
                    }
                })
                .collect()
        })
        .collect();
    let mut i = 0;
    while i < params.len() {
        let subs = &params[i];
        let Some(code) = subs[0] else {
            i += 1;
            continue;
        };
        match code {
            0 => style = TextStyle::default(),
            1 => style.bold = true,
            2 => style.dim = true,
            3 => style.italic = true,
            4 => style.underline = subs.get(1).copied().flatten() != Some(0),
            7 => style.inverse = true,
            9 => style.strike = true,
            22 => {
                style.bold = false;
                style.dim = false;
            }
            23 => style.italic = false,
            24 => style.underline = false,
            27 => style.inverse = false,
            29 => style.strike = false,
            30..=37 | 90..=97 => style.fg = Some(palette(code)),
            39 => style.fg = None,
            40..=47 | 100..=107 => style.bg = Some(palette(code - 10)),
            49 => style.bg = None,
            38 | 48 => {
                let (color, used) = if subs.len() > 1 {
                    (extended_color(&subs[1..], true), 0)
                } else {
                    let rest: Vec<Option<u16>> = params[i + 1..]
                        .iter()
                        .map(|p| if p.len() == 1 { p[0] } else { None })
                        .collect();
                    // The selector after 38/48 belongs to it even when it
                    // is not one this parser knows: read as its own code,
                    // `38;9` would strike the text through.
                    let used = match rest.first() {
                        Some(Some(5)) => 2,
                        Some(Some(2)) => 4,
                        Some(_) => 1,
                        None => 0,
                    };
                    (extended_color(&rest, false), used)
                };
                if let Some(color) = color {
                    if code == 38 {
                        style.fg = Some(color);
                    } else {
                        style.bg = Some(color);
                    }
                }
                i += used;
            }
            _ => {}
        }
        i += 1;
    }
    style
}

/// 30..37 are the eight colours, 90..97 their bright half.
fn palette(code: u16) -> AnsiColor {
    let index = if code >= 90 { code - 90 + 8 } else { code - 30 };
    AnsiColor::Named { index: index as u8 }
}

/// `5;n` or `2;r;g;b`. With colons the colour-space id may sit between
/// the `2` and the channels (`2::r:g:b`), as ITU T.416 wrote it.
fn extended_color(rest: &[Option<u16>], colons: bool) -> Option<AnsiColor> {
    let byte = |v: Option<u16>| u8::try_from(v?).ok();
    match rest.first()? {
        Some(5) => Some(AnsiColor::Indexed {
            index: byte(*rest.get(1)?)?,
        }),
        Some(2) => {
            let at = if colons && rest.len() >= 5 { 2 } else { 1 };
            Some(AnsiColor::Rgb {
                r: byte(*rest.get(at)?)?,
                g: byte(*rest.get(at + 1)?)?,
                b: byte(*rest.get(at + 2)?)?,
            })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(text: &str, style: Option<TextStyle>) -> StyledSegment {
        StyledSegment {
            text: text.to_string(),
            style,
        }
    }

    fn fg(index: u8) -> TextStyle {
        TextStyle {
            fg: Some(AnsiColor::Named { index }),
            ..TextStyle::default()
        }
    }

    fn rgb(r: u8, g: u8, b: u8) -> TextStyle {
        TextStyle {
            fg: Some(AnsiColor::Rgb { r, g, b }),
            ..TextStyle::default()
        }
    }

    /// A line with no escape at all must cost nothing and carry no
    /// segments, or every plain line in a stream would grow a payload.
    #[test]
    fn a_line_without_escapes_is_returned_as_is_with_no_segments() {
        let out = split("plain text, nothing to do");
        assert_eq!(out.text, "plain text, nothing to do");
        assert_eq!(out.segments, None);
        assert!(matches!(strip("plain"), Cow::Borrowed(_)));
    }

    /// The level word is what the level parser looks for; a colour code
    /// glued to it hid it. The cleaned text has to read exactly as the
    /// terminal would show it.
    #[test]
    fn colour_codes_leave_the_text_and_become_runs() {
        let out = split("\u{1b}[32mINFO\u{1b}[0m started in 12ms");
        assert_eq!(out.text, "INFO started in 12ms");
        assert_eq!(
            out.segments,
            Some(vec![
                seg("INFO", Some(fg(2))),
                seg(" started in 12ms", None),
            ])
        );
        assert_eq!(strip("\u{1b}[32mINFO\u{1b}[0m"), "INFO");
    }

    /// Bright colours (90..97) are the upper half of the sixteen, not a
    /// separate thing the palette has to learn.
    #[test]
    fn bright_and_bold_and_background_are_read() {
        let out = split("\u{1b}[1;91;44mERR\u{1b}[22m still red");
        let style = TextStyle {
            fg: Some(AnsiColor::Named { index: 9 }),
            bg: Some(AnsiColor::Named { index: 4 }),
            bold: true,
            ..TextStyle::default()
        };
        assert_eq!(
            out.segments,
            Some(vec![
                seg("ERR", Some(style)),
                seg(
                    " still red",
                    Some(TextStyle {
                        bold: false,
                        ..style
                    })
                ),
            ])
        );
    }

    /// `38;5;n` and `38;2;r;g;b` are the forms zerolog, chalk and friends
    /// actually emit; the colon spelling exists too, with or without the
    /// empty colour-space slot ITU T.416 puts after the `2`.
    #[test]
    fn indexed_and_truecolor_are_read_in_every_spelling() {
        let out = split(
            "\u{1b}[38;5;208mA\u{1b}[38:2:10:20:30mB\u{1b}[38:2::10:20:30mC\u{1b}[38;2;1;2;3;1mD",
        );
        assert_eq!(
            out.segments,
            Some(vec![
                seg(
                    "A",
                    Some(TextStyle {
                        fg: Some(AnsiColor::Indexed { index: 208 }),
                        ..TextStyle::default()
                    })
                ),
                seg("BC", Some(rgb(10, 20, 30))),
                seg(
                    "D",
                    Some(TextStyle {
                        bold: true,
                        ..rgb(1, 2, 3)
                    })
                ),
            ])
        );
    }

    /// `4:3` is a curly underline, one command with a sub-parameter. Read
    /// as two it would turn italic on; `4:0` read as two would reset the
    /// whole style instead of the underline.
    #[test]
    fn a_sub_parameter_belongs_to_its_command() {
        let out = split("\u{1b}[31;4:3mcurly\u{1b}[4:0mplain red");
        assert_eq!(
            out.segments,
            Some(vec![
                seg(
                    "curly",
                    Some(TextStyle {
                        underline: true,
                        ..fg(1)
                    })
                ),
                seg("plain red", Some(fg(1))),
            ])
        );
    }

    /// `38;9` is a colour selector nobody defined, not a strike-through;
    /// the number after 38 belongs to the 38.
    #[test]
    fn an_unknown_extended_colour_selector_is_not_read_as_its_own_code() {
        let out = split("\u{1b}[31m\u{1b}[38;9mtext\u{1b}[48;1mmore");
        assert_eq!(out.segments, Some(vec![seg("textmore", Some(fg(1)))]));
    }

    /// A reset nobody needed, an unknown code, or a colour with no text
    /// after it colours nothing; a line like that must not grow a payload
    /// every plain line was spared.
    #[test]
    fn a_no_op_sgr_leaves_no_segments() {
        assert_eq!(split("\u{1b}[0mplain").segments, None);
        assert_eq!(split("\u{1b}[999mplain").segments, None);
        assert_eq!(split("\u{1b}[31m").segments, None);
        assert_eq!(split("\u{1b}[31m").text, "");
    }

    /// An empty parameter list is a reset, the way terminals read `ESC[m`.
    #[test]
    fn an_empty_sgr_is_a_reset() {
        let out = split("\u{1b}[31mred\u{1b}[mplain");
        assert_eq!(
            out.segments,
            Some(vec![seg("red", Some(fg(1))), seg("plain", None)])
        );
    }

    /// A code nobody defined, a number that is not one, a channel over
    /// 255 and a private-mode sequence must not turn into a reset or a
    /// colour the program never asked for.
    #[test]
    fn unknown_and_invalid_parameters_keep_the_style_it_had() {
        let out = split("\u{1b}[31m\u{1b}[999m\u{1b}[99999m\u{1b}[38;2;999;20;30m\u{1b}[>4;2mtext");
        assert_eq!(out.segments, Some(vec![seg("text", Some(fg(1)))]));
        assert_eq!(out.text, "text");
    }

    /// Cursor movement, a window title, a hyperlink, a charset switch, a
    /// DCS payload and a bare `ESC 7` are not colour: they leave the text
    /// and leave nothing behind, and a line that had only those has no
    /// segments.
    #[test]
    fn other_escapes_are_dropped_without_becoming_style() {
        let out = split(
            "\u{1b}[2Kprogress\u{1b}]0;title\u{07} done \u{1b}]8;;https://x\u{1b}\\link\u{1b}]8;;\u{1b}\\ \u{1b}(Bhello \u{1b}Phidden\u{1b}\\there\u{1b}7",
        );
        assert_eq!(out.text, "progress done link hello there");
        assert_eq!(out.segments, None);
    }

    /// The 8-bit spellings some programs use for CSI, OSC and ST are the
    /// same sequences and end at the same places: the text after a
    /// `U+009C` terminator is text, not part of the title.
    #[test]
    fn c1_controls_are_read_like_their_7bit_forms() {
        let out = split("\u{9b}31mred\u{9b}m \u{9d}title\u{9c}visible");
        assert_eq!(out.text, "red visible");
        assert_eq!(
            out.segments,
            Some(vec![seg("red", Some(fg(1))), seg(" visible", None)])
        );
    }

    /// A sequence a program got wrong ends at the first byte the grammar
    /// does not allow, and that byte and everything after it is text.
    /// Swallowing up to the next letter would eat the word the line
    /// exists to show.
    #[test]
    fn a_malformed_sequence_ends_where_the_grammar_says_and_keeps_the_text() {
        assert_eq!(split("\u{1b}[31☃ERROR").text, "☃ERROR");
        let out = split("\u{1b}[31\u{1b}[32mgreen");
        assert_eq!(out.text, "green");
        assert_eq!(out.segments, Some(vec![seg("green", Some(fg(2)))]));
    }

    /// A sequence cut off by the end of the line must not eat the line.
    #[test]
    fn a_truncated_escape_at_the_end_does_not_lose_the_text_before_it() {
        assert_eq!(split("kept \u{1b}[3").text, "kept ");
        assert_eq!(split("kept \u{1b}").text, "kept ");
        assert_eq!(split("kept \u{1b}]8;;https://x").text, "kept ");
    }

    /// Serialized, a plain run carries nothing but its text, and a styled
    /// one carries every flag: the generated TypeScript reads them as
    /// required booleans, so none may be left out.
    #[test]
    fn the_wire_shape_omits_what_is_off() {
        let json = serde_json::to_string(&split("\u{1b}[1;34mx\u{1b}[0m y").segments).unwrap();
        assert_eq!(
            json,
            r#"[{"text":"x","style":{"fg":{"kind":"named","index":4},"bold":true,"dim":false,"italic":false,"underline":false,"inverse":false,"strike":false}},{"text":" y"}]"#
        );
    }
}
