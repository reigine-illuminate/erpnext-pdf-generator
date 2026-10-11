import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  try {
    const { html, configurator_options } = req.body;
    if (!html) return res.status(400).json({ error: 'Missing html in request body' });

    chromium.setGraphicsMode = false;

    // 1. RENDER BASE HTML TO PDF (Webflow handles pages 1 to N-1; space for Ordering Section is left blank)
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

    // Load Fonts matching Webflow CSS variables
    let notowebFontBold, notowebFontReg;
    try {
      const fontBoldRes = await fetch('https://raw.githubusercontent.com/google/fonts/main/ofl/notoserif/NotoSerif-SemiBold.ttf');
      notowebFontBold = await pdfDoc.embedFont(await fontBoldRes.arrayBuffer());

      const fontRegRes = await fetch('https://raw.githubusercontent.com/google/fonts/main/ofl/notoserif/NotoSerif-Regular.ttf');
      notowebFontReg = await pdfDoc.embedFont(await fontRegRes.arrayBuffer());
    } catch (err) {
      notowebFontBold = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);
      notowebFontReg = await pdfDoc.embedFont(StandardFonts.TimesRoman);
    }

    const form = pdfDoc.getForm();
    const pages = pdfDoc.getPages();
    const targetPage = pages[pages.length - 1]; // Target final page

    // Webflow CSS Color Variables
    const mainColor = rgb(36 / 255, 36 / 255, 2 / 255);            // #242402
    const h2Color = rgb(111 / 255, 109 / 255, 105 / 255);          // #6f6d69
    const headerBgColor = rgb(235 / 255, 235 / 230 / 255, 220 / 255); // rgba(36, 36, 2, 0.15) light tint

    // --- A. HEADER TEXT INPUT FIELDS (Top of every page) ---
    const headerConfigs = [
      { name: 'project_name', x: 69, y: 720, width: 120, height: 16 },
      { name: 'fixture_type', x: 262, y: 720, width: 120, height: 16 },
      { name: 'project_location', x: 432, y: 720, width: 120, height: 16 }
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

    // --- B. DRAW WEBFLOW SECTION HEADINGS NATIVELY ---
    let currentY = 660; // Starting Y anchor near top of order block on final page

    // 1. "HOW TO ORDER" Heading
    targetPage.drawText("HOW TO ORDER", {
      x: 40,
      y: currentY,
      size: 10,
      font: notowebFontBold,
      color: h2Color,
    });

    // "Example:" label right-aligned
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

    currentY -= 20;

    // 3. Ordering Code Bar (Table Header Row)
    targetPage.drawRectangle({
      x: 40,
      y: currentY - 4,
      width: 532,
      height: 18,
      color: headerBgColor,
    });

    targetPage.drawText("Ordering Code: {{SPEC-ORDERING-CODE-INPUT}}", {
      x: 44,
      y: currentY,
      size: 10,
      font: notowebFontBold,
      color: mainColor,
    });

    currentY -= 25; // Anchor for Row 1 Grid

    // --- C. DEFINE NATIVE GRID LAYOUT (6 Columns) ---
    // Page width = 612pt. Margin = 40pt left/right. Content area = 532pt.
    // Each column width ≈ 88pt.
    const row1Y = currentY;
    const row2Y = currentY - 140; // Offset for Row 2

    const layoutGrid = {
      // Row 1 Columns
      'WIRELESS PROTOCOL': { x: 40, y: row1Y },
      'ENVIRONMENT RATING': { x: 128, y: row1Y },
      'CCT': { x: 216, y: row1Y },
      'OUTPUT LEVEL': { x: 304, y: row1Y },
      'MOUNTING METHOD': { x: 392, y: row1Y },
      'FINISH': { x: 480, y: row1Y },

      // Row 2 Columns
      'LENGTH': { x: 40, y: row2Y },
      'START FEED DIRECTION': { x: 128, y: row2Y },
      'START FEED LENGTH': { x: 216, y: row2Y },
      'END FEED DIRECTION': { x: 304, y: row2Y },
      'END FEED LENGTH': { x: 392, y: row2Y }
    };

    // --- D. DRAW CATEGORIES, OPTIONS & ACROFORM RADIO BUTTONS ---
    if (Array.isArray(configurator_options)) {
      configurator_options.forEach((step) => {
        const optionLabel = (step.option_label || step.option_type || '').toUpperCase();

        // Match column coordinates
        let startX = 40;
        let startY = row1Y;
        for (const [key, coords] of Object.entries(layoutGrid)) {
          if (optionLabel.includes(key)) {
            startX = coords.x;
            startY = coords.y;
            break;
          }
        }

        const stepName = `step_${step.option_step}`;

        // 1. Draw Category Title Wrapper
        targetPage.drawText(optionLabel, {
          x: startX,
          y: startY,
          size: 8,
          font: notowebFontBold,
          color: mainColor,
        });

        targetPage.drawText("//", {
          x: startX + 72,
          y: startY,
          size: 8,
          font: notowebFontReg,
          color: mainColor,
        });

        // Draw 0.25pt border-bottom line
        targetPage.drawLine({
          start: { x: startX, y: startY - 3 },
          end: { x: startX + 82, y: startY - 3 },
          thickness: 0.25,
          color: mainColor,
        });

        // 2. Handle Text Input vs. Radio Buttons
        if (step.option_type === "Length") {
          const lengthField = form.createTextField(stepName);
          lengthField.addToPage(targetPage, {
            x: startX,
            y: startY - 22,
            width: 65, height: 14,
            borderWidth: 0.5, borderColor: mainColor, textColor: mainColor, font: notowebFontBold,
          });
          lengthField.setFontSize(8);

          targetPage.drawText("(spec-ordering-desc)", {
            x: startX,
            y: startY - 34,
            size: 8,
            font: notowebFontReg,
            color: h2Color,
          });

        } else {
          let allowedValues = [];
          try {
            allowedValues = typeof step.allowed_values_json === 'string' 
              ? JSON.parse(step.allowed_values_json) 
              : step.allowed_values_json;
          } catch(e){}

          if (allowedValues.length > 0) {
            const radioGroup = form.createRadioGroup(stepName);
            let defaultSelectedCode = null;

            allowedValues.forEach((valObj, idx) => {
              // 13pt line-height step per option row
              const itemY = startY - 18 - (idx * 13);
              const valCode = String(valObj.code || valObj.value || `opt_${idx}`);
              const labelCode = String(valObj.code || valCode);
              const labelDesc = String(valObj.description || valObj.label || '');

              // Place interactive AcroForm Radio Button box (8x8pt)
              radioGroup.addOptionToPage(valCode, targetPage, {
                x: startX,
                y: itemY,
                width: 8,
                height: 8,
                borderWidth: 0.5,
                borderColor: mainColor,
              });

              // Draw Code Title (Bold, 8pt)
              targetPage.drawText(`${labelCode}:`, {
                x: startX + 11,
                y: itemY + 1,
                size: 8,
                font: notowebFontBold,
                color: mainColor,
              });

              // Draw Option Description (Regular, 8pt)
              if (labelDesc) {
                const codeWidth = notowebFontBold.widthOfTextAtSize(`${labelCode}: `, 8);
                targetPage.drawText(labelDesc, {
                  x: startX + 11 + codeWidth,
                  y: itemY + 1,
                  size: 8,
                  font: notowebFontReg,
                  color: mainColor,
                });
              }

              if ((valObj.is_default === 1 || idx === 0) && !defaultSelectedCode) {
                defaultSelectedCode = valCode;
              }
            });

            if (defaultSelectedCode) {
              try { radioGroup.select(defaultSelectedCode); } catch(e){}
            }
          }
        }
      });
    }

    form.updateFieldAppearances(notowebFontBold);
    const pdfBytes = await pdfDoc.save();

    return res.status(200).json({ pdf_base64: Buffer.from(pdfBytes).toString('base64') });

  } catch (error) {
    console.error('Render Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
