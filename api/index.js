import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  try {
    const { html, configurator_options } = req.body;
    if (!html) return res.status(400).json({ error: 'Missing html in request body' });

    // Ensure graphics mode is disabled for headless Linux environments
    chromium.setGraphicsMode = false;

    // LAUNCH SERVERLESS HEADLESS BROWSER
    const browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });

    // EXTRACT DYNAMIC COORDINATES
    const domCoords = await page.evaluate(() => {
      const coords = [];
      const items = document.querySelectorAll('[data-step]');
      
      items.forEach(item => {
        const rect = item.getBoundingClientRect();
        const pageWrapper = item.closest('.page-wrapper');
        
        let relativeTop = rect.top;
        let relativeLeft = rect.left;
        
        // Measure coordinates relative to the specific printed page it lives on
        if (pageWrapper) {
          const wrapperRect = pageWrapper.getBoundingClientRect();
          relativeTop = rect.top - wrapperRect.top;
          relativeLeft = rect.left - wrapperRect.left;
        }

        coords.push({
          step: item.getAttribute('data-step'),
          code: item.getAttribute('data-code'),
          x: (relativeLeft * 0.75) + 3,
          y: 792 - (relativeTop * 0.75) - (rect.height * 0.75) + 2
        });
      });
      return coords;
    });

    const pdfBuffer = await page.pdf({ 
      format: 'Letter', 
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 }
    });
    
    await browser.close();

    // PDF-LIB ACROFORM STAMPING
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    pdfDoc.registerFontkit(fontkit);

    let customFont;
    try {
      const fontRes = await fetch('https://raw.githubusercontent.com/google/fonts/main/ofl/notoserif/NotoSerif-SemiBold.ttf');
      customFont = await pdfDoc.embedFont(await fontRes.arrayBuffer());
    } catch (err) {
      customFont = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);
    }

    const form = pdfDoc.getForm();
    const pages = pdfDoc.getPages();
    const targetPage = pages[pages.length - 1];
    const textColor = rgb(36 / 255, 36 / 255, 2 / 255);

    // HEADER FIELDS
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
          borderWidth: 0, backgroundColor: rgb(1,1,1), textColor, font: customFont,
        });
      });
      tf.setFontSize(10);
    });

    // DYNAMIC RADIO BUTTONS OVERLAY
    if (Array.isArray(configurator_options)) {
      configurator_options.forEach((step) => {
        const stepStr = String(step.option_step);
        const stepName = `step_${stepStr}`;
        const stepCoords = domCoords.filter(c => c.step === stepStr);

        if (step.option_type === "Length" && stepCoords.length > 0) {
          const lengthCoord = stepCoords[0];
          const lengthField = form.createTextField(stepName);
          lengthField.addToPage(targetPage, {
            x: lengthCoord.x,
            y: lengthCoord.y - 1,
            width: 65, height: 14,
            borderWidth: 0.5, borderColor: textColor, textColor, font: customFont,
          });
          lengthField.setFontSize(9);
        } else if (stepCoords.length > 0) {
          const radioGroup = form.createRadioGroup(stepName);
          let defaultSelectedCode = null;

          let allowedValues = [];
          try { allowedValues = typeof step.allowed_values_json === 'string' ? JSON.parse(step.allowed_values_json) : step.allowed_values_json; } catch(e){}

          stepCoords.forEach((coord) => {
            radioGroup.addOptionToPage(coord.code, targetPage, {
              x: coord.x, y: coord.y, width: 9, height: 9, borderWidth: 0.5, borderColor: textColor,
            });
          });

          allowedValues.forEach((valObj, idx) => {
            if ((valObj.is_default === 1 || idx === 0) && !defaultSelectedCode) {
              defaultSelectedCode = String(valObj.code || valObj.value);
            }
          });
          if (defaultSelectedCode) {
            try { radioGroup.select(defaultSelectedCode); } catch(e){}
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
