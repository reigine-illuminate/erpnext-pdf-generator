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

    // 1. RENDER BASE HTML TO PDF (Now without coordinate extraction)
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

    // 2. LOAD PDF-LIB FOR NATIVE DRAWING
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    pdfDoc.registerFontkit(fontkit);

    const helveticaFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    
    let customFont;
    try {
      const fontRes = await fetch('https://raw.githubusercontent.com/google/fonts/main/ofl/notoserif/NotoSerif-SemiBold.ttf');
      customFont = await pdfDoc.embedFont(await fontRes.arrayBuffer());
    } catch (err) {
      customFont = helveticaBold;
    }

    const form = pdfDoc.getForm();
    const pages = pdfDoc.getPages();
    const targetPage = pages[pages.length - 1]; // Draw on the final page
    const textColor = rgb(36 / 255, 36 / 255, 2 / 255);

    // 3. HEADER TEXT INPUTS
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
          borderWidth: 0, backgroundColor: rgb(1,1,1), textColor, font: customFont,
        });
      });
      tf.setFontSize(10);
    });

    // 4. DEFINE HARDCODED GRID FOR CATEGORY STARTING POINTS
    // Adjust these X/Y points to move entire columns
    const layoutGrid = {
      'WIRELESS PROTOCOL': { x: 36, y: 645 },
      'ENVIRONMENT RATING': { x: 116, y: 645 },
      'CCT': { x: 233, y: 645 },
      'OUTPUT LEVEL': { x: 348, y: 645 },
      'MOUNTING METHOD': { x: 432, y: 645 },
      'FINISH': { x: 512, y: 645 },
      // Row 2
      'LENGTH': { x: 36, y: 460 },
      'START FEED DIRECTION': { x: 116, y: 460 },
      'START FEED LENGTH': { x: 216, y: 460 },
      'END FEED DIRECTION': { x: 316, y: 460 },
      'END FEED LENGTH': { x: 416, y: 460 }
    };

    // 5. DRAW THE NATIVE ORDERING SECTION
    if (Array.isArray(configurator_options)) {
      configurator_options.forEach((step) => {
        const optionLabel = (step.option_label || step.option_type || '').toUpperCase();
        
        // Find matching coordinate in the grid
        let startX = 36;
        let startY = 645;
        for (const [key, coords] of Object.entries(layoutGrid)) {
          if (optionLabel.includes(key)) {
            startX = coords.x;
            startY = coords.y;
            break;
          }
        }

        const stepName = `step_${step.option_step}`;

        // Draw Category Title
        targetPage.drawText(optionLabel, {
          x: startX,
          y: startY,
          size: 7,
          font: helveticaBold,
          color: textColor,
        });

        // Handle Length Text Box vs Radio Groups
        if (step.option_type === "Length") {
          const lengthField = form.createTextField(stepName);
          lengthField.addToPage(targetPage, {
            x: startX,
            y: startY - 20,
            width: 65, height: 14,
            borderWidth: 0.5, borderColor: textColor, textColor, font: customFont,
          });
          lengthField.setFontSize(9);
          
          targetPage.drawText("(inches)", {
             x: startX, y: startY - 32, size: 7, font: helveticaFont, color: textColor 
          });

        } else {
          let allowedValues = [];
          try { allowedValues = typeof step.allowed_values_json === 'string' ? JSON.parse(step.allowed_values_json) : step.allowed_values_json; } catch(e){}

          if (allowedValues.length > 0) {
            const radioGroup = form.createRadioGroup(stepName);
            let defaultSelectedCode = null;

            allowedValues.forEach((valObj, idx) => {
              const itemY = startY - 18 - (idx * 13); // Drop 18pt for title, then 13pt per row
              const valCode = String(valObj.code || valObj.value || `opt_${idx}`);
              const labelText = String(valObj.label || valCode);

              // 1. Draw the visual text (e.g., "27K: 2700K")
              targetPage.drawText(labelText, {
                x: startX + 13, // Shift text right of the checkbox
                y: itemY,
                size: 7,
                font: helveticaFont,
                color: textColor,
              });

              // 2. Draw the interactive radio button right next to it
              radioGroup.addOptionToPage(valCode, targetPage, {
                x: startX,
                y: itemY,
                width: 9,
                height: 9,
                borderWidth: 0.5,
                borderColor: textColor,
              });

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

    form.updateFieldAppearances(customFont);
    const pdfBytes = await pdfDoc.save();
    
    return res.status(200).json({ pdf_base64: Buffer.from(pdfBytes).toString('base64') });
    
  } catch (error) {
    console.error('Render Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
