"""Tests for make_portrait.py. Run: python -m unittest discover -s scripts -p "test_*.py" (from profile/)."""
import os
import sys
import tempfile
import unittest

from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(__file__))
from make_portrait import edge_glyph, portrait  # noqa: E402


def ring_image(path):
    img = Image.new("L", (200, 200), 0)
    d = ImageDraw.Draw(img)
    d.ellipse((30, 30, 170, 170), fill=255)
    d.ellipse((75, 75, 125, 125), fill=0)
    img.save(path)


class EdgeGlyphs(unittest.TestCase):
    def test_outline_follows_the_side_the_outside_is_on(self):
        self.assertEqual(edge_glyph(-1, 0), "|")
        self.assertEqual(edge_glyph(1, 0), "|")
        self.assertEqual(edge_glyph(0, -1), "-")  # outside above: a top edge
        self.assertEqual(edge_glyph(0, 1), "_")  # outside below: a bottom edge
        self.assertEqual(edge_glyph(1, -1), "\\")  # top-right corner
        self.assertEqual(edge_glyph(-1, -1), "/")  # top-left corner
        self.assertEqual(edge_glyph(-1, 1), "\\")  # bottom-left corner
        self.assertEqual(edge_glyph(1, 1), "/")  # bottom-right corner


class Portrait(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.src = os.path.join(self.dir.name, "ring.png")
        ring_image(self.src)

    def tearDown(self):
        self.dir.cleanup()

    def test_grid_has_the_requested_width_and_matching_level_rows(self):
        p = portrait(self.src, cols=30)
        self.assertEqual(p["cols"], 30)
        self.assertEqual(len(p["chars"]), p["rows"])
        for chars, levels in zip(p["chars"], p["levels"]):
            self.assertEqual(len(chars), 30)
            self.assertEqual(len(levels), 30)
            for ch, lv in zip(chars, levels):
                self.assertEqual(ch == " ", lv == " ")
                self.assertTrue(lv == " " or lv.isdigit())

    def test_the_hole_in_the_middle_stays_empty_and_the_ring_is_drawn(self):
        p = portrait(self.src, cols=30, dust=0, sparkles=0, field=0)
        mid_row = p["chars"][p["rows"] // 2]
        self.assertEqual(mid_row[15], " ")
        self.assertNotEqual(mid_row[3].strip() + mid_row[4].strip(), "")

    def test_same_input_gives_the_same_picture(self):
        self.assertEqual(portrait(self.src, cols=30), portrait(self.src, cols=30))

    def test_an_image_with_no_bright_mark_is_refused_with_a_reason(self):
        dark = os.path.join(self.dir.name, "dark.png")
        Image.new("L", (50, 50), 10).save(dark)
        with self.assertRaisesRegex(ValueError, "no pixels brighter"):
            portrait(dark)

    def test_credits_the_method(self):
        self.assertIn("JIN2", portrait(self.src, cols=20)["credit"])


if __name__ == "__main__":
    unittest.main()
