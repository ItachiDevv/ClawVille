"""Deterministic vector wood for both ClawVille sign builders."""

from __future__ import annotations

import random
from html import escape


def wood_plank(outline: str, bbox: tuple[int, int, int, int], prefix: str) -> tuple[str, str]:
    """Return SVG defs and the complete clipped plank group."""
    x0, y0, x1, y1 = bbox
    width, height = x1 - x0, y1 - y0
    rng = random.Random(21741)
    tones = ("#4A210E", "#633015", "#B9773F", "#D09658")
    streaks: dict[tuple[int, int], list[str]] = {(tone, weight): [] for tone in range(4) for weight in range(2)}
    rows = max(100, round(height * 1.3))
    for row in range(rows):
        y = y0 + (row + rng.random()) * height / rows
        # Several short strands per row preserve texture across the complete width.
        for _ in range(rng.randint(2, 4)):
            length = width * rng.uniform(.045, .24)
            x = rng.uniform(x0 - length * .3, x1 - length * .7)
            bend = rng.uniform(-1.7, 1.7) * height / 280
            tone = rng.randrange(4)
            weight = 1 if rng.random() < .18 else 0
            streaks[tone, weight].append(
                f"M{x:.1f} {y:.1f}q{length/4:.1f} {bend:.1f} {length/2:.1f} 0t{length/2:.1f} 0"
            )
    grain = "".join(
        f'<path d="{" ".join(streaks[tone, weight])}" stroke="{tones[tone]}" '
        f'stroke-width="{height * (.0024 if weight == 0 else .0045):.1f}" '
        f'opacity="{(.18, .16, .22, .15)[tone]}"/>'
        for tone in range(4) for weight in range(2)
    )
    knots = []
    for fraction in (.19, .48, .77):
        cx = x0 + width * fraction
        cy = y0 + height * rng.uniform(.28, .73)
        for radius in (1, 1.8, 2.7):
            rx, ry = height * .14 * radius, height * .012 * radius
            knots.append(
                f'<ellipse cx="{cx:.1f}" cy="{cy:.1f}" rx="{rx:.1f}" ry="{ry:.1f}" '
                f'fill="none" stroke="#5C2B12" stroke-width=".8" opacity=".24"/>'
            )
    edge_lines = []
    for _ in range(140):
        x = rng.uniform(x0, x1)
        y = rng.uniform(y0, y1)
        length = rng.uniform(.012, .055) * width
        edge_lines.append(f"M{x:.1f} {y:.1f}q{length/2:.1f} {rng.uniform(-1, 1):.1f} {length:.1f} 0")
    name = escape(prefix, quote=True)
    rim = height * .065
    defs = (
        f'<path id="{name}Outline" d="{escape(outline, quote=True)}"/>'
        f'<clipPath id="{name}Clip"><use href="#{name}Outline"/></clipPath>'
        f'<mask id="{name}Edge" maskUnits="userSpaceOnUse" '
        f'x="{x0-rim:.1f}" y="{y0-rim:.1f}" '
        f'width="{width+2*rim:.1f}" height="{height+2*rim:.1f}">'
        f'<use href="#{name}Outline" fill="none" stroke="white" '
        f'stroke-width="{rim:.1f}"/></mask>'
        f'<linearGradient id="{name}Wood" x1="0" y1="0" x2="0" y2="1" '
        f'gradientUnits="objectBoundingBox"><stop stop-color="#A9622F"/>'
        f'<stop offset=".35" stop-color="#985326"/>'
        f'<stop offset=".72" stop-color="#8A4A20"/>'
        f'<stop offset="1" stop-color="#673216"/></linearGradient>'
    )
    group = (
        f'<g clip-path="url(#{name}Clip)">'
        f'<use href="#{name}Outline" fill="url(#{name}Wood)"/>'
        f'<g fill="none" stroke-linecap="round">{grain}{"".join(knots)}</g>'
        f'<use href="#{name}Outline" fill="none" stroke="#57290F" '
        f'stroke-width="{rim:.1f}" opacity=".75"/>'
        f'<g mask="url(#{name}Edge)" fill="none" stroke="#B1763B" '
        f'stroke-width="{height * .007:.1f}" opacity=".32" stroke-linecap="round">'
        f'<path d="{" ".join(edge_lines)}"/></g>'
        f'<use href="#{name}Outline" fill="none" stroke="#C38449" '
        f'stroke-width="{height * .009:.1f}" opacity=".38"/>'
        '</g>'
    )
    return defs, group
