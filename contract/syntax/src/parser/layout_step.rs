//! Geometry comparisons in viewport points, using the agent's `layout` reply.

use super::*;

impl Parser {
    fn layout_dimension(&mut self) -> R<String> {
        const MEASURES: &[&str] = &[
            "width", "height", "x", "y", "left", "right", "top", "bottom", "centerX", "centerY",
        ];
        if let TokenKind::Ident(word) = self.peek_kind() {
            if MEASURES.contains(&word.as_str()) {
                let word = word.clone();
                self.next();
                return Ok(word);
            }
        }
        self.err(
            "syntax-expected-step",
            format!(
                "`expect layout` needs a size (width, height), edge (left, right, top, bottom), position (x, y) or center (centerX, centerY), found {}",
                describe(self.peek_kind())
            ),
        )
    }

    /// After `expect layout`, read the box, comparison and optional tolerance.
    pub(super) fn expect_layout(&mut self, span: Span) -> R<Step> {
        let target = self.str_lit("a testId")?;
        let dimension = self.layout_dimension()?;
        let comparison = if self.eat_punct("==") {
            StateComparison::Equal
        } else if self.eat_punct("<=") {
            StateComparison::AtMost
        } else if self.eat_punct(">=") {
            StateComparison::AtLeast
        } else {
            return self.err(
                "syntax-expected-step",
                format!(
                    "`expect layout` takes `==`, `<=` or `>=`, found {}",
                    describe(self.peek_kind())
                ),
            );
        };
        let value = if self.at_ident("layout") {
            self.next();
            crate::LayoutOperand::BoxMeasure {
                target: self.str_lit("a testId")?,
                dimension: self.layout_dimension()?,
            }
        } else {
            let n = self.step_number("a coordinate or size in viewport points")?;
            if n < 0. && matches!(dimension.as_str(), "width" | "height") {
                return self.err(
                    "syntax-expected-step",
                    "`expect layout` compares a size of 0 or more",
                );
            }
            crate::LayoutOperand::Points(n)
        };
        let tolerance = if self.at_ident("within") {
            self.next();
            let n = self.step_number("a nonnegative tolerance in points")?;
            if n < 0. {
                return self.err(
                    "syntax-expected-step",
                    "layout tolerance must be nonnegative",
                );
            }
            Some(n)
        } else {
            None
        };
        if let TokenKind::Ident(unit) = self.peek_kind() {
            return self.err(
                "syntax-expected-step",
                format!("`expect layout` compares in points, written bare; unexpected `{unit}`"),
            );
        }
        Ok(Step::ExpectLayout {
            target,
            dimension,
            comparison,
            value,
            tolerance,
            span,
        })
    }
}
