import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

// Helper function to calculate flex-like text wrapping within column boundaries
function wrapText(text, font, fontSize, maxWidth) {
  if (!text) return [];
  const words = text.split(' ');
  const lines = [];
  let currentLine = '';

  for (let word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    const testWidth = font.widthOfTextAtSize(testLine, fontSize);
    if (testWidth <= maxWidth) {
      currentLine = testLine;
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  try {
    const { html, configurator_options } = req.body;
    if (!html) return res.status(400).json({ error: 'Missing html in request body' });

    chromium.setGraphicsMode = false;

    // 1. RENDER BASE HTML TO PDF
    const browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdfBuffer = await page.pdf({ 
      format: 'Letter', 
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 }
    });
    await browser.close();

    // 2. LOAD INTO PDF-LIB FOR NATIVE RECREATION
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    pdfDoc.registerFontkit(fontkit);

    // Load Static TrueType Noto Serif Fonts (Fontsource TTFs guarantee PDF-lib fontkit compatibility)
    let notowebFontBold, notowebFontReg;
    try {
      const fontBoldRes = await fetch('https://cdn.jsdelivr.net/npm/@fontsource/noto-serif@5.0.18/files/noto-serif-latin-600-normal.ttf');
      notowebFontBold = await pdfDoc.embedFont(await fontBoldRes.arrayBuffer());

      const fontRegRes = await fetch('https://cdn.jsdelivr.net/npm/@fontsource/noto-serif@5.0.18/files/noto-serif-latin-400-normal.ttf');
      notowebFontReg = await pdfDoc.embedFont(await fontRegRes.arrayBuffer());
    } catch (err) {
      console.error('Font fetch error:', err);
      notowebFontBold = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);
      notowebFontReg = await pdfDoc.embedFont(StandardFonts.TimesRoman);
    }

    const form = pdfDoc.getForm();
    const pages = pdfDoc.getPages();
    const targetPage = pages[pages.length - 1]; // Target final page

    // Webflow Color Palette
    const mainColor = rgb(36 / 255, 36 / 255, 2 / 255);            // #242402
    const h2Color = rgb(111 / 255, 109 / 255, 105 / 255);          // #6f6d69
    const headerBgColor = rgb(222 / 255, 222 / 255, 217 / 255);   // rgba(36, 36, 2, 0.15) tint

    // --- A. HEADER TEXT INPUT FIELDS (Top of every page) ---
    const headerConfigs = [
      { name: 'project_name', x: 79, y: 705, width: 130, height: 16 },
      { name: 'fixture_type', x: 265, y: 705, width: 130, height: 16 },
      { name: 'project_location', x: 442, y: 705, width: 140, height: 16 }
    ];

    headerConfigs.forEach(cfg => {
      const tf = form.createTextField(cfg.name);
      pages.forEach(p => {
        tf.addToPage(p, {
          x: cfg.x, y: cfg.y, width: cfg.width, height: cfg.height,
          borderWidth: 0, backgroundColor: rgb(1,1,1), textColor: mainColor, font: notowebFontBold,
        });
      });
      tf.setFontSize(10);
    });

    // --- B. SECTION HEADINGS ---
    let currentY = 660;

    // 1. "HOW TO ORDER" Heading
    targetPage.drawText("HOW TO ORDER", {
      x: 40,
      y: currentY,
      size: 10,
      font: notowebFontBold,
      color: h2Color,
    });

    targetPage.drawText("Example:", {
      x: 520,
      y: currentY,
      size: 8,
      font: notowebFontReg,
      color: h2Color,
    });

    currentY -= 12;

    // 2. Subtext
    targetPage.drawText("Select options below to create your ordering code.", {
      x: 40,
      y: currentY,
      size: 8,
      font: notowebFontReg,
      color: mainColor,
    });

    currentY -= 18;

    // 3. Ordering Code Bar (Table Header Row)
    targetPage.drawRectangle({
      x: 40,
      y: currentY - 3,
      width: 532,
      height: 16,
      color: headerBgColor,
    });

    targetPage.drawText("Ordering Code: {{SPEC-ORDERING-CODE-INPUT}}", {
      x: 44,
      y: currentY + 1,
      size: 10,
      font: notowebFontBold,
      color: mainColor,
    });

    // Zero top-margin gap: Row 1 groups start immediately below the header bar
    currentY -= 14; 

    // --- C. DYNAMIC GRID ENGINE WITH WRAPPING WRAPPERS (Max 6 cols per row) ---
    const pageMarginLeft = 40;
    const totalContentWidth = 532;
    const maxCols = 6;
    const colWidth = totalContentWidth / maxCols; // ~88.66pt per column wrapper

    // Chunk steps into rows of up to 6
    const rowChunks = [];
    if (Array.isArray(configurator_options)) {
      for (let i = 0; i < configurator_options.length; i += maxCols) {
        rowChunks.push(configurator_options.slice(i, i + maxCols));
      }
    }

    rowChunks.forEach((rowSteps) => {
      let lowestYInRow = currentY;

      rowSteps.forEach((step, colIdx) => {
        const startX = pageMarginLeft + (colIdx * colWidth);
        let cursorY = currentY;

        const optionLabel = (step.option_label || step.option_type || '').toUpperCase();
        const stepName = `step_${step.option_step}`;

        // 1. Draw Category Header with text wrapping
        const titleLines = wrapText(optionLabel, notowebFontBold, 7, colWidth - 14);
        titleLines.forEach((tLine, tIdx) => {
          targetPage.drawText(tLine, {
            x: startX,
            y: cursorY - (tIdx * 8),
            size: 7,
            font: notowebFontBold,
            color: mainColor,
          });
        });

        // Draw // separator
        targetPage.drawText("//", {
          x: startX + colWidth - 10,
          y: cursorY,
          size: 7,
          font: notowebFontReg,
          color: mainColor,
        });

        const titleHeightOffset = (titleLines.length - 1) * 8;
        const lineY = cursorY - 3 - titleHeightOffset;

        // Draw 0.25pt border-bottom line
        targetPage.drawLine({
          start: { x: startX, y: lineY },
          end: { x: startX + colWidth - 6, y: lineY },
          thickness: 0.25,
          color: mainColor,
        });

        cursorY = lineY - 10; // Position cursor below category title bar

        // 2. Render Form Controls (Length Input vs Radio Buttons)
        if (step.option_type === "Length") {
          const lengthField = form.createTextField(stepName);
          lengthField.addToPage(targetPage, {
            x: startX,
            y: cursorY - 10,
            width: Math.min(65, colWidth - 10),
            height: 14,
            borderWidth: 0.5, borderColor: mainColor, textColor: mainColor, font: notowebFontBold,
          });
          lengthField.setFontSize(8);

          targetPage.drawText("(spec-ordering-desc)", {
            x: startX,
            y: cursorY - 22,
            size: 7,
            font: notowebFontReg,
            color: h2Color,
          });

          cursorY -= 32;

        } else {
          let allowedValues = [];
          try {
            allowedValues = typeof step.allowed_values_json === 'string' 
              ? JSON.parse(step.allowed_values_json) 
              : step.allowed_values_json;
          } catch(e){}

          if (Array.isArray(allowedValues) && allowedValues.length > 0) {
            const radioGroup = form.createRadioGroup(stepName);
            let defaultSelectedCode = null;

            allowedValues.forEach((valObj, idx) => {
              const valCode = String(valObj.code || valObj.value || `opt_${idx}`);
              const labelCode = String(valObj.code || valCode);
              const labelDesc = String(valObj.description || valObj.label || '');

              // Interactive Radio Button Box
              radioGroup.addOptionToPage(valCode, targetPage, {
                x: startX,
                y: cursorY,
                width: 8,
                height: 8,
                borderWidth: 0.5,
                borderColor: mainColor,
              });

              // Option Code Title (Bold)
              const codeString = `${labelCode}:`;
              targetPage.drawText(codeString, {
                x: startX + 11,
                y: cursorY + 1,
                size: 7,
                font: notowebFontBold,
                color: mainColor,
              });

              const codeWidth = notowebFontBold.widthOfTextAtSize(`${codeString} `, 7);
              const descAvailableWidth = colWidth - 11 - codeWidth - 2;

              if (labelDesc) {
                // Wrap text if description exceeds remaining column width
                const descLines = wrapText(labelDesc, notowebFontReg, 7, descAvailableWidth > 20 ? descAvailableWidth : colWidth - 11);

                if (descAvailableWidth > 20 && descLines.length > 0) {
                  // Draw Line 1 adjacent to code
                  targetPage.drawText(descLines[0], {
                    x: startX + 11 + codeWidth,
                    y: cursorY + 1,
                    size: 7,
                    font: notowebFontReg,
                    color: mainColor,
                  });

                  // Draw subsequent lines wrapped underneath
                  for (let dIdx = 1; dIdx < descLines.length; dIdx++) {
                    cursorY -= 9;
                    targetPage.drawText(descLines[dIdx], {
                      x: startX + 11,
                      y: cursorY + 1,
                      size: 7,
                      font: notowebFontReg,
                      color: mainColor,
                    });
                  }
                } else {
                  // Wrap all description lines below code
                  descLines.forEach((dLine) => {
                    cursorY -= 9;
                    targetPage.drawText(dLine, {
                      x: startX + 11,
                      y: cursorY + 1,
                      size: 7,
                      font: notowebFontReg,
                      color: mainColor,
                    });
                  });
                }
              }

              if ((valObj.is_default === 1 || idx === 0) && !defaultSelectedCode) {
                defaultSelectedCode = valCode;
              }

              // Advance Y down for next option item
              cursorY -= 12;
            });

            if (defaultSelectedCode) {
              try { radioGroup.select(defaultSelectedCode); } catch(e){}
            }
          }
        }

        // Track the lowest Y coordinate reached by any group in this row
        if (cursorY < lowestYInRow) {
          lowestYInRow = cursorY;
        }
      });

      // Exactly 10px spacing between Row 1 and Row 2
      currentY = lowestYInRow - 10;
    });

    form.updateFieldAppearances(notowebFontBold);
    const pdfBytes = await pdfDoc.save();

    return res.status(200).json({ pdf_base64: Buffer.from(pdfBytes).toString('base64') });

  } catch (error) {
    console.error('Render Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
