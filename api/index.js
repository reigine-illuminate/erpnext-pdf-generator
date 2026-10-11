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

    // Load Webflow Noto Serif Fonts
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

    // Webflow Color Palette (Converted to PDF 0-1 float scale)
    const mainColor = rgb(36 / 255, 36 / 255, 2 / 255);            // #242402
    const h2Color = rgb(111 / 255, 109 / 255, 105 / 255);          // #6f6d69
    const headerBgColor = rgb(222 / 255, 222 / 255, 217 / 255);   // rgba(36, 36, 2, 0.15) light tint

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

    // --- B. SECTION HEADINGS ---
    let currentY = 660; // Starting Y anchor

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

    // 3. Ordering Code Bar (Header Row)
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

    currentY -= 25; // Grid starting anchor

    // --- C. DYNAMIC FLEX GRID ENGINE (Max 6 columns per row) ---
    const pageMarginLeft = 40;
    const totalContentWidth = 532; // 612pt letter width - 80pt margins
    const maxCols = 6;
    const colWidth = totalContentWidth / maxCols; // 88.66pt per column

    // Chunk steps into rows of up to 6
    const rowChunks = [];
    if (Array.isArray(configurator_options)) {
      for (let i = 0; i < configurator_options.length; i += maxCols) {
        rowChunks.push(configurator_options.slice(i, i + maxCols));
      }
    }

    rowChunks.forEach((rowSteps) => {
      let maxItemsInCurrentRow = 1;

      rowSteps.forEach((step, colIdx) => {
        const startX = pageMarginLeft + (colIdx * colWidth);
        const startY = currentY;

        const optionLabel = (step.option_label || step.option_type || '').toUpperCase();
        const stepName = `step_${step.option_step}`;

        // 1. Draw Category Header & Separator
        targetPage.drawText(optionLabel, {
          x: startX,
          y: startY,
          size: 7.5,
          font: notowebFontBold,
          color: mainColor,
        });

        targetPage.drawText("//", {
          x: startX + colWidth - 12,
          y: startY,
          size: 7.5,
          font: notowebFontReg,
          color: mainColor,
        });

        // 0.25pt border-bottom line
        targetPage.drawLine({
          start: { x: startX, y: startY - 3 },
          end: { x: startX + colWidth - 6, y: startY - 3 },
          thickness: 0.25,
          color: mainColor,
        });

        // 2. Render Form Controls (Length Input vs Radio Buttons)
        if (step.option_type === "Length") {
          maxItemsInCurrentRow = Math.max(maxItemsInCurrentRow, 3);
          
          const lengthField = form.createTextField(stepName);
          lengthField.addToPage(targetPage, {
            x: startX,
            y: startY - 22,
            width: Math.min(65, colWidth - 10),
            height: 14,
            borderWidth: 0.5, borderColor: mainColor, textColor: mainColor, font: notowebFontBold,
          });
          lengthField.setFontSize(8);

          targetPage.drawText("(spec-ordering-desc)", {
            x: startX,
            y: startY - 34,
            size: 7,
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

          if (Array.isArray(allowedValues) && allowedValues.length > 0) {
            maxItemsInCurrentRow = Math.max(maxItemsInCurrentRow, allowedValues.length);
            
            const radioGroup = form.createRadioGroup(stepName);
            let defaultSelectedCode = null;

            allowedValues.forEach((valObj, idx) => {
              const itemY = startY - 16 - (idx * 13);
              const valCode = String(valObj.code || valObj.value || `opt_${idx}`);
              const labelCode = String(valObj.code || valCode);
              const labelDesc = String(valObj.description || valObj.label || '');

              // Interactive Radio Button Box
              radioGroup.addOptionToPage(valCode, targetPage, {
                x: startX,
                y: itemY,
                width: 8,
                height: 8,
                borderWidth: 0.5,
                borderColor: mainColor,
              });

              // Option Code Title
              targetPage.drawText(`${labelCode}:`, {
                x: startX + 11,
                y: itemY + 1,
                size: 7.5,
                font: notowebFontBold,
                color: mainColor,
              });

              // Option Description Label
              if (labelDesc) {
                const codeWidth = notowebFontBold.widthOfTextAtSize(`${labelCode}: `, 7.5);
                targetPage.drawText(labelDesc, {
                  x: startX + 11 + codeWidth,
                  y: itemY + 1,
                  size: 7.5,
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

      // Advance Y downward dynamically based on the tallest category in this row
      const dynamicRowHeight = 18 + (maxItemsInCurrentRow * 13) + 16;
      currentY -= dynamicRowHeight;
    });

    form.updateFieldAppearances(notowebFontBold);
    const pdfBytes = await pdfDoc.save();

    return res.status(200).json({ pdf_base64: Buffer.from(pdfBytes).toString('base64') });

  } catch (error) {
    console.error('Render Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
