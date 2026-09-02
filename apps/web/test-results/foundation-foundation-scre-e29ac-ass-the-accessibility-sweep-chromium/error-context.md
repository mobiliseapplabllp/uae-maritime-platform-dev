# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: foundation.spec.ts >> foundation screens >> administration and data studio pages load and pass the accessibility sweep
- Location: e2e/foundation.spec.ts:18:3

# Error details

```
Error: /berth-board: color-contrast (10)

expect(received).toEqual(expected) // deep equality

- Expected  -   1
+ Received  + 379

- Array []
+ Array [
+   Object {
+     "description": "Ensure the contrast between foreground and background colors meets WCAG 2 AA minimum contrast ratio thresholds",
+     "help": "Elements must meet minimum color contrast ratio thresholds",
+     "helpUrl": "https://dequeuniversity.com/rules/axe/4.13/color-contrast?application=playwright",
+     "id": "color-contrast",
+     "impact": "serious",
+     "nodes": Array [
+       Object {
+         "all": Array [],
+         "any": Array [
+           Object {
+             "data": Object {
+               "bgColor": "#0797a5",
+               "contrastRatio": 3.51,
+               "expectedContrastRatio": "4.5:1",
+               "fgColor": "#ffffff",
+               "fontSize": "8.3pt (11px)",
+               "fontWeight": "bold",
+               "messageKey": null,
+             },
+             "id": "color-contrast",
+             "impact": "serious",
+             "message": "Element has insufficient color contrast of 3.51 (foreground color: #ffffff, background color: #0797a5, font size: 8.3pt (11px), font weight: bold). Expected contrast ratio of 4.5:1",
+             "relatedNodes": Array [
+               Object {
+                 "html": "<div class=\"MuiChip-root MuiChip-filled MuiChip-sizeSmall MuiChip-colorDefault MuiChip-filledDefault mui-73w5q1-MuiChip-root\"><span class=\"MuiChip-label MuiChip-labelSmall mui-t3ycia-MuiChip-label\">Harbour Operations</span></div>",
+                 "target": Array [
+                   ".mui-73w5q1-MuiChip-root",
+                 ],
+               },
+             ],
+           },
+         ],
+         "failureSummary": "Fix any of the following:
+   Element has insufficient color contrast of 3.51 (foreground color: #ffffff, background color: #0797a5, font size: 8.3pt (11px), font weight: bold). Expected contrast ratio of 4.5:1",
+         "html": "<span class=\"MuiChip-label MuiChip-labelSmall mui-t3ycia-MuiChip-label\">Harbour Operations</span>",
+         "impact": "serious",
+         "none": Array [],
+         "target": Array [
+           ".mui-73w5q1-MuiChip-root > .mui-t3ycia-MuiChip-label.MuiChip-label.MuiChip-labelSmall",
+         ],
+       },
+       Object {
+         "all": Array [],
+         "any": Array [
+           Object {
+             "data": Object {
+               "bgColor": "#e6eef0",
+               "contrastRatio": 4.31,
+               "expectedContrastRatio": "4.5:1",
+               "fgColor": "#0b74b0",
+               "fontSize": "9.0pt (12px)",
+               "fontWeight": "normal",
+               "messageKey": null,
+             },
+             "id": "color-contrast",
+             "impact": "serious",
+             "message": "Element has insufficient color contrast of 4.31 (foreground color: #0b74b0, background color: #e6eef0, font size: 9.0pt (12px), font weight: normal). Expected contrast ratio of 4.5:1",
+             "relatedNodes": Array [
+               Object {
+                 "html": "<div class=\"MuiPaper-root MuiPaper-elevation MuiPaper-rounded MuiPaper-elevation0 MuiCard-root mui-1w8xdvi-MuiPaper-root-MuiCard-root\">",
+                 "target": Array [
+                   ".mui-0.MuiBox-root:nth-child(1) > .MuiGrid-container.MuiGrid-spacing-xs-1\\.5.mui-acctgf-MuiGrid-root > .MuiGrid-item.MuiGrid-grid-xs-12.MuiGrid-grid-sm-6:nth-child(2) > .mui-1w8xdvi-MuiPaper-root-MuiCard-root.MuiPaper-rounded.MuiCard-root",
+                 ],
+               },
+               Object {
+                 "html": "<body>",
+                 "target": Array [
+                   "body",
+                 ],
+               },
+             ],
+           },
+         ],
+         "failureSummary": "Fix any of the following:
+   Element has insufficient color contrast of 4.31 (foreground color: #0b74b0, background color: #e6eef0, font size: 9.0pt (12px), font weight: normal). Expected contrast ratio of 4.5:1",
+         "html": "<span class=\"MuiTypography-root MuiTypography-caption mui-1sswvcl-MuiTypography-root\">ETD in 6 hours</span>",
+         "impact": "serious",
+         "none": Array [],
+         "target": Array [
+           ".mui-0.MuiBox-root:nth-child(1) > .MuiGrid-container.MuiGrid-spacing-xs-1\\.5.mui-acctgf-MuiGrid-root > .MuiGrid-item.MuiGrid-grid-xs-12.MuiGrid-grid-sm-6:nth-child(2) > .mui-1w8xdvi-MuiPaper-root-MuiCard-root.MuiPaper-rounded.MuiCard-root > .mui-4g6ai3.MuiBox-root > .mui-1sswvcl-MuiTypography-root.MuiTypography-caption.MuiTypography-root",
+         ],
+       },
+       Object {
+         "all": Array [],
+         "any": Array [
+           Object {
+             "data": Object {
+               "bgColor": "#e6eef0",
+               "contrastRatio": 4.31,
+               "expectedContrastRatio": "4.5:1",
+               "fgColor": "#0b74b0",
+               "fontSize": "9.0pt (12px)",
+               "fontWeight": "normal",
+               "messageKey": null,
+             },
+             "id": "color-contrast",
+             "impact": "serious",
+             "message": "Element has insufficient color contrast of 4.31 (foreground color: #0b74b0, background color: #e6eef0, font size: 9.0pt (12px), font weight: normal). Expected contrast ratio of 4.5:1",
+             "relatedNodes": Array [
+               Object {
+                 "html": "<div class=\"MuiPaper-root MuiPaper-elevation MuiPaper-rounded MuiPaper-elevation0 MuiCard-root mui-1w8xdvi-MuiPaper-root-MuiCard-root\">",
+                 "target": Array [
+                   ".mui-0.MuiBox-root:nth-child(4) > .MuiGrid-container.MuiGrid-spacing-xs-1\\.5.mui-acctgf-MuiGrid-root > .MuiGrid-item.MuiGrid-grid-xs-12.MuiGrid-grid-sm-6:nth-child(1) > .mui-1w8xdvi-MuiPaper-root-MuiCard-root.MuiPaper-rounded.MuiCard-root",
+                 ],
+               },
+             ],
+           },
+         ],
+         "failureSummary": "Fix any of the following:
+   Element has insufficient color contrast of 4.31 (foreground color: #0b74b0, background color: #e6eef0, font size: 9.0pt (12px), font weight: normal). Expected contrast ratio of 4.5:1",
+         "html": "<span class=\"MuiTypography-root MuiTypography-caption mui-1sswvcl-MuiTypography-root\">ETD in 2 days</span>",
+         "impact": "serious",
+         "none": Array [],
+         "target": Array [
+           ".mui-0.MuiBox-root:nth-child(4) > .MuiGrid-container.MuiGrid-spacing-xs-1\\.5.mui-acctgf-MuiGrid-root > .MuiGrid-item.MuiGrid-grid-xs-12.MuiGrid-grid-sm-6:nth-child(1) > .mui-1w8xdvi-MuiPaper-root-MuiCard-root.MuiPaper-rounded.MuiCard-root > .mui-4g6ai3.MuiBox-root > .mui-1sswvcl-MuiTypography-root.MuiTypography-caption.MuiTypography-root",
+         ],
+       },
+       Object {
+         "all": Array [],
+         "any": Array [
+           Object {
+             "data": Object {
+               "bgColor": "#e6eef0",
+               "contrastRatio": 4.31,
+               "expectedContrastRatio": "4.5:1",
+               "fgColor": "#0b74b0",
+               "fontSize": "9.0pt (12px)",
+               "fontWeight": "normal",
+               "messageKey": null,
+             },
+             "id": "color-contrast",
+             "impact": "serious",
+             "message": "Element has insufficient color contrast of 4.31 (foreground color: #0b74b0, background color: #e6eef0, font size: 9.0pt (12px), font weight: normal). Expected contrast ratio of 4.5:1",
+             "relatedNodes": Array [
+               Object {
+                 "html": "<div class=\"MuiPaper-root MuiPaper-elevation MuiPaper-rounded MuiPaper-elevation0 MuiCard-root mui-1w8xdvi-MuiPaper-root-MuiCard-root\">",
+                 "target": Array [
+                   ".mui-0.MuiBox-root:nth-child(5) > .MuiGrid-container.MuiGrid-spacing-xs-1\\.5.mui-acctgf-MuiGrid-root > .MuiGrid-item.MuiGrid-grid-xs-12.MuiGrid-grid-sm-6:nth-child(2) > .mui-1w8xdvi-MuiPaper-root-MuiCard-root.MuiPaper-rounded.MuiCard-root",
+                 ],
+               },
+             ],
+           },
+         ],
+         "failureSummary": "Fix any of the following:
+   Element has insufficient color contrast of 4.31 (foreground color: #0b74b0, background color: #e6eef0, font size: 9.0pt (12px), font weight: normal). Expected contrast ratio of 4.5:1",
+         "html": "<span class=\"MuiTypography-root MuiTypography-caption mui-1sswvcl-MuiTypography-root\">ETD in 2 days</span>",
+         "impact": "serious",
+         "none": Array [],
+         "target": Array [
+           ".mui-0.MuiBox-root:nth-child(5) > .MuiGrid-container.MuiGrid-spacing-xs-1\\.5.mui-acctgf-MuiGrid-root > .MuiGrid-item.MuiGrid-grid-xs-12.MuiGrid-grid-sm-6:nth-child(2) > .mui-1w8xdvi-MuiPaper-root-MuiCard-root.MuiPaper-rounded.MuiCard-root > .mui-4g6ai3.MuiBox-root > .mui-1sswvcl-MuiTypography-root.MuiTypography-caption.MuiTypography-root",
+         ],
+       },
+       Object {
+         "all": Array [],
+         "any": Array [
+           Object {
+             "data": Object {
+               "bgColor": "#e6eef0",
+               "contrastRatio": 4.31,
+               "expectedContrastRatio": "4.5:1",
+               "fgColor": "#0b74b0",
+               "fontSize": "9.0pt (12px)",
+               "fontWeight": "normal",
+               "messageKey": null,
+             },
+             "id": "color-contrast",
+             "impact": "serious",
+             "message": "Element has insufficient color contrast of 4.31 (foreground color: #0b74b0, background color: #e6eef0, font size: 9.0pt (12px), font weight: normal). Expected contrast ratio of 4.5:1",
+             "relatedNodes": Array [
+               Object {
+                 "html": "<div class=\"MuiPaper-root MuiPaper-elevation MuiPaper-rounded MuiPaper-elevation0 MuiCard-root mui-1w8xdvi-MuiPaper-root-MuiCard-root\">",
+                 "target": Array [
+                   ".mui-0.MuiBox-root:nth-child(6) > .MuiGrid-container.MuiGrid-spacing-xs-1\\.5.mui-acctgf-MuiGrid-root > .MuiGrid-item.MuiGrid-grid-xs-12.MuiGrid-grid-sm-6:nth-child(1) > .mui-1w8xdvi-MuiPaper-root-MuiCard-root.MuiPaper-rounded.MuiCard-root",
+                 ],
+               },
+             ],
+           },
+         ],
+         "failureSummary": "Fix any of the following:
+   Element has insufficient color contrast of 4.31 (foreground color: #0b74b0, background color: #e6eef0, font size: 9.0pt (12px), font weight: normal). Expected contrast ratio of 4.5:1",
+         "html": "<span class=\"MuiTypography-root MuiTypography-caption mui-1sswvcl-MuiTypography-root\">ETD in 2 days</span>",
+         "impact": "serious",
+         "none": Array [],
+         "target": Array [
+           ".mui-0.MuiBox-root:nth-child(6) > .MuiGrid-container.MuiGrid-spacing-xs-1\\.5.mui-acctgf-MuiGrid-root > .MuiGrid-item.MuiGrid-grid-xs-12.MuiGrid-grid-sm-6:nth-child(1) > .mui-1w8xdvi-MuiPaper-root-MuiCard-root.MuiPaper-rounded.MuiCard-root > .mui-4g6ai3.MuiBox-root > .mui-1sswvcl-MuiTypography-root.MuiTypography-caption.MuiTypography-root",
+         ],
+       },
+       Object {
+         "all": Array [],
+         "any": Array [
+           Object {
+             "data": Object {
+               "bgColor": "#e6eef0",
+               "contrastRatio": 4.31,
+               "expectedContrastRatio": "4.5:1",
+               "fgColor": "#0b74b0",
+               "fontSize": "9.0pt (12px)",
+               "fontWeight": "normal",
+               "messageKey": null,
+             },
+             "id": "color-contrast",
+             "impact": "serious",
+             "message": "Element has insufficient color contrast of 4.31 (foreground color: #0b74b0, background color: #e6eef0, font size: 9.0pt (12px), font weight: normal). Expected contrast ratio of 4.5:1",
+             "relatedNodes": Array [
+               Object {
+                 "html": "<div class=\"MuiPaper-root MuiPaper-elevation MuiPaper-rounded MuiPaper-elevation0 MuiCard-root mui-1w8xdvi-MuiPaper-root-MuiCard-root\">",
+                 "target": Array [
+                   ".mui-0.MuiBox-root:nth-child(6) > .MuiGrid-container.MuiGrid-spacing-xs-1\\.5.mui-acctgf-MuiGrid-root > .MuiGrid-item.MuiGrid-grid-xs-12.MuiGrid-grid-sm-6:nth-child(3) > .mui-1w8xdvi-MuiPaper-root-MuiCard-root.MuiPaper-rounded.MuiCard-root",
+                 ],
+               },
+             ],
+           },
+         ],
+         "failureSummary": "Fix any of the following:
+   Element has insufficient color contrast of 4.31 (foreground color: #0b74b0, background color: #e6eef0, font size: 9.0pt (12px), font weight: normal). Expected contrast ratio of 4.5:1",
+         "html": "<span class=\"MuiTypography-root MuiTypography-caption mui-1sswvcl-MuiTypography-root\">ETD in 13 hours</span>",
+         "impact": "serious",
+         "none": Array [],
+         "target": Array [
+           ".mui-0.MuiBox-root:nth-child(6) > .MuiGrid-container.MuiGrid-spacing-xs-1\\.5.mui-acctgf-MuiGrid-root > .MuiGrid-item.MuiGrid-grid-xs-12.MuiGrid-grid-sm-6:nth-child(3) > .mui-1w8xdvi-MuiPaper-root-MuiCard-root.MuiPaper-rounded.MuiCard-root > .mui-4g6ai3.MuiBox-root > .mui-1sswvcl-MuiTypography-root.MuiTypography-caption.MuiTypography-root",
+         ],
+       },
+       Object {
+         "all": Array [],
+         "any": Array [
+           Object {
+             "data": Object {
+               "bgColor": "#e6eef0",
+               "contrastRatio": 4.31,
+               "expectedContrastRatio": "4.5:1",
+               "fgColor": "#0b74b0",
+               "fontSize": "9.0pt (12px)",
+               "fontWeight": "normal",
+               "messageKey": null,
+             },
+             "id": "color-contrast",
+             "impact": "serious",
+             "message": "Element has insufficient color contrast of 4.31 (foreground color: #0b74b0, background color: #e6eef0, font size: 9.0pt (12px), font weight: normal). Expected contrast ratio of 4.5:1",
+             "relatedNodes": Array [
+               Object {
+                 "html": "<div class=\"MuiPaper-root MuiPaper-elevation MuiPaper-rounded MuiPaper-elevation0 MuiCard-root mui-1w8xdvi-MuiPaper-root-MuiCard-root\">",
+                 "target": Array [
+                   ".MuiGrid-item.MuiGrid-grid-xs-12.MuiGrid-grid-sm-6:nth-child(4) > .mui-1w8xdvi-MuiPaper-root-MuiCard-root.MuiPaper-rounded.MuiCard-root",
+                 ],
+               },
+             ],
+           },
+         ],
+         "failureSummary": "Fix any of the following:
+   Element has insufficient color contrast of 4.31 (foreground color: #0b74b0, background color: #e6eef0, font size: 9.0pt (12px), font weight: normal). Expected contrast ratio of 4.5:1",
+         "html": "<span class=\"MuiTypography-root MuiTypography-caption mui-1sswvcl-MuiTypography-root\">ETD in 2 days</span>",
+         "impact": "serious",
+         "none": Array [],
+         "target": Array [
+           ".MuiGrid-item.MuiGrid-grid-xs-12.MuiGrid-grid-sm-6:nth-child(4) > .mui-1w8xdvi-MuiPaper-root-MuiCard-root.MuiPaper-rounded.MuiCard-root > .mui-4g6ai3.MuiBox-root > .mui-1sswvcl-MuiTypography-root.MuiTypography-caption.MuiTypography-root",
+         ],
+       },
+       Object {
+         "all": Array [],
+         "any": Array [
+           Object {
+             "data": Object {
+               "bgColor": "#e6eef0",
+               "contrastRatio": 4.31,
+               "expectedContrastRatio": "4.5:1",
+               "fgColor": "#0b74b0",
+               "fontSize": "9.0pt (12px)",
+               "fontWeight": "normal",
+               "messageKey": null,
+             },
+             "id": "color-contrast",
+             "impact": "serious",
+             "message": "Element has insufficient color contrast of 4.31 (foreground color: #0b74b0, background color: #e6eef0, font size: 9.0pt (12px), font weight: normal). Expected contrast ratio of 4.5:1",
+             "relatedNodes": Array [
+               Object {
+                 "html": "<div class=\"MuiPaper-root MuiPaper-elevation MuiPaper-rounded MuiPaper-elevation0 MuiCard-root mui-1w8xdvi-MuiPaper-root-MuiCard-root\">",
+                 "target": Array [
+                   ".mui-0.MuiBox-root:nth-child(8) > .MuiGrid-container.MuiGrid-spacing-xs-1\\.5.mui-acctgf-MuiGrid-root > .MuiGrid-item.MuiGrid-grid-xs-12.MuiGrid-grid-sm-6:nth-child(1) > .mui-1w8xdvi-MuiPaper-root-MuiCard-root.MuiPaper-rounded.MuiCard-root",
+                 ],
+               },
+             ],
+           },
+         ],
+         "failureSummary": "Fix any of the following:
+   Element has insufficient color contrast of 4.31 (foreground color: #0b74b0, background color: #e6eef0, font size: 9.0pt (12px), font weight: normal). Expected contrast ratio of 4.5:1",
+         "html": "<span class=\"MuiTypography-root MuiTypography-caption mui-1sswvcl-MuiTypography-root\">ETD in 10 hours</span>",
+         "impact": "serious",
+         "none": Array [],
+         "target": Array [
+           ".mui-0.MuiBox-root:nth-child(8) > .MuiGrid-container.MuiGrid-spacing-xs-1\\.5.mui-acctgf-MuiGrid-root > .MuiGrid-item.MuiGrid-grid-xs-12.MuiGrid-grid-sm-6:nth-child(1) > .mui-1w8xdvi-MuiPaper-root-MuiCard-root.MuiPaper-rounded.MuiCard-root > .mui-4g6ai3.MuiBox-root > .mui-1sswvcl-MuiTypography-root.MuiTypography-caption.MuiTypography-root",
+         ],
+       },
+       Object {
+         "all": Array [],
+         "any": Array [
+           Object {
+             "data": Object {
+               "bgColor": "#e6eef0",
+               "contrastRatio": 4.31,
+               "expectedContrastRatio": "4.5:1",
+               "fgColor": "#0b74b0",
+               "fontSize": "9.0pt (12px)",
+               "fontWeight": "normal",
+               "messageKey": null,
+             },
+             "id": "color-contrast",
+             "impact": "serious",
+             "message": "Element has insufficient color contrast of 4.31 (foreground color: #0b74b0, background color: #e6eef0, font size: 9.0pt (12px), font weight: normal). Expected contrast ratio of 4.5:1",
+             "relatedNodes": Array [
+               Object {
+                 "html": "<div class=\"MuiPaper-root MuiPaper-elevation MuiPaper-rounded MuiPaper-elevation0 MuiCard-root mui-1w8xdvi-MuiPaper-root-MuiCard-root\">",
+                 "target": Array [
+                   ".mui-0.MuiBox-root:nth-child(9) > .MuiGrid-container.MuiGrid-spacing-xs-1\\.5.mui-acctgf-MuiGrid-root > .MuiGrid-item.MuiGrid-grid-xs-12.MuiGrid-grid-sm-6:nth-child(1) > .mui-1w8xdvi-MuiPaper-root-MuiCard-root.MuiPaper-rounded.MuiCard-root",
+                 ],
+               },
+             ],
+           },
+         ],
+         "failureSummary": "Fix any of the following:
+   Element has insufficient color contrast of 4.31 (foreground color: #0b74b0, background color: #e6eef0, font size: 9.0pt (12px), font weight: normal). Expected contrast ratio of 4.5:1",
+         "html": "<span class=\"MuiTypography-root MuiTypography-caption mui-1sswvcl-MuiTypography-root\">ETD in a day</span>",
+         "impact": "serious",
+         "none": Array [],
+         "target": Array [
+           ".mui-0.MuiBox-root:nth-child(9) > .MuiGrid-container.MuiGrid-spacing-xs-1\\.5.mui-acctgf-MuiGrid-root > .MuiGrid-item.MuiGrid-grid-xs-12.MuiGrid-grid-sm-6:nth-child(1) > .mui-1w8xdvi-MuiPaper-root-MuiCard-root.MuiPaper-rounded.MuiCard-root > .mui-4g6ai3.MuiBox-root > .mui-1sswvcl-MuiTypography-root.MuiTypography-caption.MuiTypography-root",
+         ],
+       },
+       Object {
+         "all": Array [],
+         "any": Array [
+           Object {
+             "data": Object {
+               "bgColor": "#e6eef0",
+               "contrastRatio": 4.31,
+               "expectedContrastRatio": "4.5:1",
+               "fgColor": "#0b74b0",
+               "fontSize": "9.0pt (12px)",
+               "fontWeight": "normal",
+               "messageKey": null,
+             },
+             "id": "color-contrast",
+             "impact": "serious",
+             "message": "Element has insufficient color contrast of 4.31 (foreground color: #0b74b0, background color: #e6eef0, font size: 9.0pt (12px), font weight: normal). Expected contrast ratio of 4.5:1",
+             "relatedNodes": Array [
+               Object {
+                 "html": "<div class=\"MuiPaper-root MuiPaper-elevation MuiPaper-rounded MuiPaper-elevation0 MuiCard-root mui-1w8xdvi-MuiPaper-root-MuiCard-root\">",
+                 "target": Array [
+                   ".mui-0.MuiBox-root:nth-child(9) > .MuiGrid-container.MuiGrid-spacing-xs-1\\.5.mui-acctgf-MuiGrid-root > .MuiGrid-item.MuiGrid-grid-xs-12.MuiGrid-grid-sm-6:nth-child(3) > .mui-1w8xdvi-MuiPaper-root-MuiCard-root.MuiPaper-rounded.MuiCard-root",
+                 ],
+               },
+             ],
+           },
+         ],
+         "failureSummary": "Fix any of the following:
+   Element has insufficient color contrast of 4.31 (foreground color: #0b74b0, background color: #e6eef0, font size: 9.0pt (12px), font weight: normal). Expected contrast ratio of 4.5:1",
+         "html": "<span class=\"MuiTypography-root MuiTypography-caption mui-1sswvcl-MuiTypography-root\">ETD in a day</span>",
+         "impact": "serious",
+         "none": Array [],
+         "target": Array [
+           ".mui-0.MuiBox-root:nth-child(9) > .MuiGrid-container.MuiGrid-spacing-xs-1\\.5.mui-acctgf-MuiGrid-root > .MuiGrid-item.MuiGrid-grid-xs-12.MuiGrid-grid-sm-6:nth-child(3) > .mui-1w8xdvi-MuiPaper-root-MuiCard-root.MuiPaper-rounded.MuiCard-root > .mui-4g6ai3.MuiBox-root > .mui-1sswvcl-MuiTypography-root.MuiTypography-caption.MuiTypography-root",
+         ],
+       },
+     ],
+     "tags": Array [
+       "cat.color",
+       "wcag2aa",
+       "wcag143",
+       "TTv5",
+       "TT13.c",
+       "EN-301-549",
+       "EN-9.1.4.3",
+       "ACT",
+       "RGAAv4",
+       "RGAA-3.2.1",
+     ],
+   },
+ ]
```

# Page snapshot

```yaml
- generic [ref=f8e3]:
  - navigation "Module navigation" [ref=f8e6]:
    - generic [ref=f8e11]:
      - paragraph [ref=f8e12]: Maritime Operations
      - paragraph [ref=f8e13]: UNIFIED · MARITIME
    - generic [ref=f8e18]:
      - paragraph [ref=f8e19]: Harbour Operations
      - paragraph [ref=f8e20]: Active module
    - generic [ref=f8e21]:
      - generic [ref=f8e22]:
        - generic [ref=f8e23]: Marine operations
        - link "Vessel Calls" [ref=f8e24] [cursor=pointer]:
          - /url: /port-calls
        - link "Berth Board" [ref=f8e30] [cursor=pointer]:
          - /url: /berth-board
        - link "Berth Window Planner" [ref=f8e36] [cursor=pointer]:
          - /url: /berth-planner
        - link "Quay View (2D)" [ref=f8e42] [cursor=pointer]:
          - /url: /quay-view
        - link "Vessel Schedule" [ref=f8e48] [cursor=pointer]:
          - /url: /schedule
        - link "Marine Craft & Pilots" [ref=f8e54] [cursor=pointer]:
          - /url: /marine-services
        - link "Live Traffic" [ref=f8e60] [cursor=pointer]:
          - /url: /nmc/map
      - generic [ref=f8e66]:
        - generic [ref=f8e67]: Configuration
        - link "Module Settings" [ref=f8e68] [cursor=pointer]:
          - /url: /settings/module/ops
      - separator [ref=f8e74]
      - button "Maritime Insights AI analytics" [ref=f8e75] [cursor=pointer]:
        - generic [ref=f8e79]:
          - generic [ref=f8e80]: Maritime Insights
          - paragraph [ref=f8e81]: AI analytics
      - button "All applications" [ref=f8e84] [cursor=pointer]
    - separator [ref=f8e90]
    - generic [ref=f8e91]:
      - generic [ref=f8e92]: AS
      - generic [ref=f8e93]:
        - paragraph [ref=f8e94]: Ashish Sharma
        - paragraph [ref=f8e95]: Super Admin
  - generic [ref=f8e96]:
    - banner [ref=f8e97]:
      - generic [ref=f8e98]:
        - button "All applications" [ref=f8e99] [cursor=pointer]
        - generic [ref=f8e102]: Harbour Operations
        - button "Search everything…" [ref=f8e104] [cursor=pointer]:
          - paragraph [ref=f8e107]: Search everything…
          - generic [ref=f8e108]: Ctrl K
        - generic [ref=f8e110]: DEMO DATA
        - button "العربية" [ref=f8e112] [cursor=pointer]
        - button "Dark mode" [ref=f8e115] [cursor=pointer]
        - button "Notifications" [ref=f8e118] [cursor=pointer]:
          - generic [ref=f8e119]: "35"
        - button "Account menu" [ref=f8e123] [cursor=pointer]:
          - generic [ref=f8e124]: AS
      - progressbar [ref=f8e125]
    - main [ref=f8e126]:
      - generic [ref=f8e127]:
        - generic [ref=f8e128]:
          - generic [ref=f8e133]:
            - heading "Berth board" [level=1] [ref=f8e134]
            - paragraph [ref=f8e135]: Live occupancy across every terminal — with the berth master maintained in place
          - generic [ref=f8e136]:
            - group "View" [ref=f8e137]:
              - button "Cards" [pressed] [ref=f8e138] [cursor=pointer]
              - button "Table" [ref=f8e141] [cursor=pointer]
            - button [ref=f8e144] [cursor=pointer]
        - generic [ref=f8e148]:
          - generic [ref=f8e149]:
            - paragraph [ref=f8e150]: "24"
            - paragraph [ref=f8e151]: Berths
            - paragraph [ref=f8e152]: 1 under maintenance
          - generic [ref=f8e153]:
            - paragraph [ref=f8e154]: "9"
            - paragraph [ref=f8e155]: Occupied now
            - paragraph [ref=f8e156]: vessels alongside
          - generic [ref=f8e157]:
            - paragraph [ref=f8e158]: 39%
            - paragraph [ref=f8e159]: Occupancy
            - paragraph [ref=f8e160]: of operational berths
          - generic [ref=f8e161]:
            - paragraph [ref=f8e162]: "14"
            - paragraph [ref=f8e163]: Free & operational
            - paragraph [ref=f8e164]: ready for allocation
          - generic [ref=f8e165]:
            - paragraph [ref=f8e166]: 400 m
            - paragraph [ref=f8e167]: Longest quay
            - paragraph [ref=f8e168]: max LOA accepted
          - generic [ref=f8e169]:
            - paragraph [ref=f8e170]: 22 m
            - paragraph [ref=f8e171]: Deepest berth
            - paragraph [ref=f8e172]: max declared draft
          - generic [ref=f8e173]:
            - paragraph [ref=f8e174]: "39"
            - paragraph [ref=f8e175]: Outages (12 m)
            - paragraph [ref=f8e176]: 233 days lost
          - generic [ref=f8e177]:
            - paragraph [ref=f8e178]: 97.3%
            - paragraph [ref=f8e179]: Berth availability
            - paragraph [ref=f8e180]: operational time, 12 months
        - generic [ref=f8e181]:
          - generic [ref=f8e182]:
            - paragraph [ref=f8e183]: Container Terminal 1
            - generic [ref=f8e184]:
              - generic [ref=f8e186]:
                - generic [ref=f8e187]:
                  - paragraph [ref=f8e188]: CT1-1
                  - generic [ref=f8e189]: Free
                - generic [ref=f8e191]: Container Terminal 1 — Berth 1 — available
                - generic [ref=f8e192]:
                  - button "Toggle maintenance" [ref=f8e193] [cursor=pointer]
                  - button "Edit berth" [ref=f8e196] [cursor=pointer]
              - generic [ref=f8e200]:
                - generic [ref=f8e201]:
                  - paragraph [ref=f8e202]: CT1-2
                  - generic [ref=f8e203]: Occupied
                - generic [ref=f8e205] [cursor=pointer]:
                  - paragraph [ref=f8e206]: Maersk Kensington
                  - generic [ref=f8e207]: MAR-2026-0252 · berthed 01 Sep 2026, 11:20
                  - generic [ref=f8e208]: ETD in 6 hours
                - generic [ref=f8e209]:
                  - button "Toggle maintenance" [ref=f8e210] [cursor=pointer]
                  - button "Edit berth" [ref=f8e213] [cursor=pointer]
          - generic [ref=f8e216]:
            - paragraph [ref=f8e217]: Container Terminal 3
            - generic [ref=f8e218]:
              - generic [ref=f8e220]:
                - generic [ref=f8e221]:
                  - paragraph [ref=f8e222]: CT3-1
                  - generic [ref=f8e223]: Free
                - generic [ref=f8e225]: Container Terminal 3 — Berth 1 — available
                - generic [ref=f8e226]:
                  - button "Toggle maintenance" [ref=f8e227] [cursor=pointer]
                  - button "Edit berth" [ref=f8e230] [cursor=pointer]
              - generic [ref=f8e234]:
                - generic [ref=f8e235]:
                  - paragraph [ref=f8e236]: CT3-2
                  - generic [ref=f8e237]: Free
                - generic [ref=f8e239]: Container Terminal 3 — Berth 2 — available
                - generic [ref=f8e240]:
                  - button "Toggle maintenance" [ref=f8e241] [cursor=pointer]
                  - button "Edit berth" [ref=f8e244] [cursor=pointer]
          - generic [ref=f8e247]:
            - paragraph [ref=f8e248]: Container Terminal 4
            - generic [ref=f8e249]:
              - generic [ref=f8e251]:
                - generic [ref=f8e252]:
                  - paragraph [ref=f8e253]: CT4-1
                  - generic [ref=f8e254]: Free
                - generic [ref=f8e256]: Container Terminal 4 — Berth 1 — available
                - generic [ref=f8e257]:
                  - button "Toggle maintenance" [ref=f8e258] [cursor=pointer]
                  - button "Edit berth" [ref=f8e261] [cursor=pointer]
              - generic [ref=f8e265]:
                - generic [ref=f8e266]:
                  - paragraph [ref=f8e267]: CT4-2
                  - generic [ref=f8e268]: Free
                - generic [ref=f8e270]: Container Terminal 4 — Berth 2 — available
                - generic [ref=f8e271]:
                  - button "Toggle maintenance" [ref=f8e272] [cursor=pointer]
                  - button "Edit berth" [ref=f8e275] [cursor=pointer]
          - generic [ref=f8e278]:
            - paragraph [ref=f8e279]: Container Terminal 5
            - generic [ref=f8e280]:
              - generic [ref=f8e282]:
                - generic [ref=f8e283]:
                  - paragraph [ref=f8e284]: CT5-1
                  - generic [ref=f8e285]: Occupied
                - generic [ref=f8e287] [cursor=pointer]:
                  - paragraph [ref=f8e288]: Corniche Navigator
                  - generic [ref=f8e289]: MAR-2026-0256 · berthed 01 Sep 2026, 22:20
                  - generic [ref=f8e290]: ETD in 2 days
                - generic [ref=f8e291]:
                  - button "Toggle maintenance" [ref=f8e292] [cursor=pointer]
                  - button "Edit berth" [ref=f8e295] [cursor=pointer]
              - generic [ref=f8e299]:
                - generic [ref=f8e300]:
                  - paragraph [ref=f8e301]: CT5-2
                  - generic [ref=f8e302]: Maintenance
                - generic [ref=f8e304]: Container Terminal 5 — Berth 2
                - generic [ref=f8e305]:
                  - button "Toggle maintenance" [ref=f8e306] [cursor=pointer]
                  - button "Edit berth" [ref=f8e309] [cursor=pointer]
          - generic [ref=f8e312]:
            - paragraph [ref=f8e313]: Liquid Terminal
            - generic [ref=f8e314]:
              - generic [ref=f8e316]:
                - generic [ref=f8e317]:
                  - paragraph [ref=f8e318]: LB-1
                  - generic [ref=f8e319]: Free
                - generic [ref=f8e321]: Liquid Berth 1 — available
                - generic [ref=f8e322]:
                  - button "Toggle maintenance" [ref=f8e323] [cursor=pointer]
                  - button "Edit berth" [ref=f8e326] [cursor=pointer]
              - generic [ref=f8e330]:
                - generic [ref=f8e331]:
                  - paragraph [ref=f8e332]: LB-2
                  - generic [ref=f8e333]: Occupied
                - generic [ref=f8e335] [cursor=pointer]:
                  - paragraph [ref=f8e336]: Ruwais Spirit
                  - generic [ref=f8e337]: MAR-2026-0251 · berthed 01 Sep 2026, 12:20
                  - generic [ref=f8e338]: ETD in 2 days
                - generic [ref=f8e339]:
                  - button "Toggle maintenance" [ref=f8e340] [cursor=pointer]
                  - button "Edit berth" [ref=f8e343] [cursor=pointer]
              - generic [ref=f8e347]:
                - generic [ref=f8e348]:
                  - paragraph [ref=f8e349]: LB-3
                  - generic [ref=f8e350]: Free
                - generic [ref=f8e352]: Liquid Berth 3 — available
                - generic [ref=f8e353]:
                  - button "Toggle maintenance" [ref=f8e354] [cursor=pointer]
                  - button "Edit berth" [ref=f8e357] [cursor=pointer]
              - generic [ref=f8e361]:
                - generic [ref=f8e362]:
                  - paragraph [ref=f8e363]: LB-4
                  - generic [ref=f8e364]: Free
                - generic [ref=f8e366]: Liquid Berth 4 — available
                - generic [ref=f8e367]:
                  - button "Toggle maintenance" [ref=f8e368] [cursor=pointer]
                  - button "Edit berth" [ref=f8e371] [cursor=pointer]
          - generic [ref=f8e374]:
            - paragraph [ref=f8e375]: Multipurpose Terminal
            - generic [ref=f8e376]:
              - generic [ref=f8e378]:
                - generic [ref=f8e379]:
                  - paragraph [ref=f8e380]: MP-1
                  - generic [ref=f8e381]: Occupied
                - generic [ref=f8e383] [cursor=pointer]:
                  - paragraph [ref=f8e384]: Mina Zayed Trader
                  - generic [ref=f8e385]: MAR-2026-0258 · berthed 02 Sep 2026, 19:20
                  - generic [ref=f8e386]: ETD in 2 days
                - generic [ref=f8e387]:
                  - button "Toggle maintenance" [ref=f8e388] [cursor=pointer]
                  - button "Edit berth" [ref=f8e391] [cursor=pointer]
              - generic [ref=f8e395]:
                - generic [ref=f8e396]:
                  - paragraph [ref=f8e397]: MP-2
                  - generic [ref=f8e398]: Free
                - generic [ref=f8e400]: Multipurpose Berth 2 — available
                - generic [ref=f8e401]:
                  - button "Toggle maintenance" [ref=f8e402] [cursor=pointer]
                  - button "Edit berth" [ref=f8e405] [cursor=pointer]
              - generic [ref=f8e409]:
                - generic [ref=f8e410]:
                  - paragraph [ref=f8e411]: MP-3
                  - generic [ref=f8e412]: Occupied
                - generic [ref=f8e414] [cursor=pointer]:
                  - paragraph [ref=f8e415]: Saadiyat Breeze
                  - generic [ref=f8e416]: MAR-2026-0255 · berthed 02 Sep 2026, 04:20
                  - generic [ref=f8e417]: ETD in 13 hours
                - generic [ref=f8e418]:
                  - button "Toggle maintenance" [ref=f8e419] [cursor=pointer]
                  - button "Edit berth" [ref=f8e422] [cursor=pointer]
              - generic [ref=f8e426]:
                - generic [ref=f8e427]:
                  - paragraph [ref=f8e428]: MP-4
                  - generic [ref=f8e429]: Occupied
                - generic [ref=f8e431] [cursor=pointer]:
                  - paragraph [ref=f8e432]: Sir Bani Yas
                  - generic [ref=f8e433]: MAR-2026-0253 · berthed 02 Sep 2026, 19:20
                  - generic [ref=f8e434]: ETD in 2 days
                - generic [ref=f8e435]:
                  - button "Toggle maintenance" [ref=f8e436] [cursor=pointer]
                  - button "Edit berth" [ref=f8e439] [cursor=pointer]
          - generic [ref=f8e442]:
            - paragraph [ref=f8e443]: Offshore SPM
            - generic [ref=f8e444]:
              - generic [ref=f8e446]:
                - generic [ref=f8e447]:
                  - paragraph [ref=f8e448]: SPM-1
                  - generic [ref=f8e449]: Free
                - generic [ref=f8e451]: Single Point Mooring 1 — available
                - generic [ref=f8e452]:
                  - button "Toggle maintenance" [ref=f8e453] [cursor=pointer]
                  - button "Edit berth" [ref=f8e456] [cursor=pointer]
              - generic [ref=f8e460]:
                - generic [ref=f8e461]:
                  - paragraph [ref=f8e462]: SPM-2
                  - generic [ref=f8e463]: Free
                - generic [ref=f8e465]: Single Point Mooring 2 — available
                - generic [ref=f8e466]:
                  - button "Toggle maintenance" [ref=f8e467] [cursor=pointer]
                  - button "Edit berth" [ref=f8e470] [cursor=pointer]
          - generic [ref=f8e473]:
            - paragraph [ref=f8e474]: Ro-Ro Terminal
            - generic [ref=f8e475]:
              - generic [ref=f8e477]:
                - generic [ref=f8e478]:
                  - paragraph [ref=f8e479]: RR-1
                  - generic [ref=f8e480]: Occupied
                - generic [ref=f8e482] [cursor=pointer]:
                  - paragraph [ref=f8e483]: Ajman Pioneer
                  - generic [ref=f8e484]: MAR-2026-0257 · berthed 02 Sep 2026, 03:20
                  - generic [ref=f8e485]: ETD in 10 hours
                - generic [ref=f8e486]:
                  - button "Toggle maintenance" [ref=f8e487] [cursor=pointer]
                  - button "Edit berth" [ref=f8e490] [cursor=pointer]
              - generic [ref=f8e494]:
                - generic [ref=f8e495]:
                  - paragraph [ref=f8e496]: RR-2
                  - generic [ref=f8e497]: Free
                - generic [ref=f8e499]: Ro-Ro Berth 2 — available
                - generic [ref=f8e500]:
                  - button "Toggle maintenance" [ref=f8e501] [cursor=pointer]
                  - button "Edit berth" [ref=f8e504] [cursor=pointer]
          - generic [ref=f8e507]:
            - paragraph [ref=f8e508]: West Basin Bulk Terminal
            - generic [ref=f8e509]:
              - generic [ref=f8e511]:
                - generic [ref=f8e512]:
                  - paragraph [ref=f8e513]: WB-1
                  - generic [ref=f8e514]: Occupied
                - generic [ref=f8e516] [cursor=pointer]:
                  - paragraph [ref=f8e517]: Marawah Endeavour
                  - generic [ref=f8e518]: MAR-2026-0250 · berthed 01 Sep 2026, 10:20
                  - generic [ref=f8e519]: ETD in a day
                - generic [ref=f8e520]:
                  - button "Toggle maintenance" [ref=f8e521] [cursor=pointer]
                  - button "Edit berth" [ref=f8e524] [cursor=pointer]
              - generic [ref=f8e528]:
                - generic [ref=f8e529]:
                  - paragraph [ref=f8e530]: WB-2
                  - generic [ref=f8e531]: Free
                - generic [ref=f8e533]: West Basin Bulk Berth 2 — available
                - generic [ref=f8e534]:
                  - button "Toggle maintenance" [ref=f8e535] [cursor=pointer]
                  - button "Edit berth" [ref=f8e538] [cursor=pointer]
              - generic [ref=f8e542]:
                - generic [ref=f8e543]:
                  - paragraph [ref=f8e544]: WB-3
                  - generic [ref=f8e545]: Occupied
                - generic [ref=f8e547] [cursor=pointer]:
                  - paragraph [ref=f8e548]: Hatta Crest
                  - generic [ref=f8e549]: MAR-2026-0254 · berthed 01 Sep 2026, 19:20
                  - generic [ref=f8e550]: ETD in a day
                - generic [ref=f8e551]:
                  - button "Toggle maintenance" [ref=f8e552] [cursor=pointer]
                  - button "Edit berth" [ref=f8e555] [cursor=pointer]
              - generic [ref=f8e559]:
                - generic [ref=f8e560]:
                  - paragraph [ref=f8e561]: WB-4
                  - generic [ref=f8e562]: Free
                - generic [ref=f8e564]: West Basin Bulk Berth 4 — available
                - generic [ref=f8e565]:
                  - button "Toggle maintenance" [ref=f8e566] [cursor=pointer]
                  - button "Edit berth" [ref=f8e569] [cursor=pointer]
  - button "Open the port assistant" [ref=f8e572] [cursor=pointer]
```

# Test source

```ts
  1  | import { expect, type Page } from '@playwright/test';
  2  | import AxeBuilder from '@axe-core/playwright';
  3  | 
  4  | export async function login(page: Page, role: 'super-admin' | 'harbour-master' | 'marine-surveyor' | 'finance-officer' | 'shipping-agent' = 'super-admin') {
  5  |   await page.goto('/login');
  6  |   await page.getByTestId(`login-${role}`).click();
  7  |   await expect(page.getByRole('heading', { name: /Port operations|No access/ })).toBeVisible({ timeout: 20_000 });
  8  | }
  9  | /** WCAG 2.2 AA sweep with axe-core; fails on serious and critical violations. */
  10 | export async function expectAccessible(page: Page, context?: string) {
  11 |   const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  12 |   const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
> 13 |   expect(serious, `${context || page.url()}: ${serious.map((v) => `${v.id} (${v.nodes.length})`).join(', ')}`).toEqual([]);
     |                                                                                                                ^ Error: /berth-board: color-contrast (10)
  14 | }
  15 | 
```