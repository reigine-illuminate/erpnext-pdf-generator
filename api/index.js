import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

export default async function handler(req, res) {
  // Only allow POST requests (like n8n sends)
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  try {
    const { pdf_url, configurator_options } = req.body;
    
    if (!pdf_url) {
      return res.status(400).json({ error: 'Missing pdf_url in request body' });
    }

    // 1. Fetch base PDF binary from Api2Pdf
    const pdfRes = await fetch(pdf_url);
    if (!pdfRes.ok) {
      return res.status(400).json({ error: `Failed to fetch PDF: ${pdfRes.statusText}` });
    }
    const pdfBuffer = Buffer.from(await pdfRes.arrayBuffer());

    // 2. Load PDF into pdf-lib & register custom fontkit
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    pdfDoc.registerFontkit(fontkit);

    let customFont;
    try {
      const fontRes = await fetch('https://raw.githubusercontent.com/google/fonts/main/ofl/notoserif/NotoSerif-SemiBold.ttf');
      const fontBytes = await fontRes.arrayBuffer();
      customFont = await pdfDoc.embedFont(fontBytes);
    } catch (err) {
      customFont = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);
    }

    const form = pdfDoc.getForm();
    const pages = pdfDoc.getPages();
    
    // TARGET THE DYNAMIC LAST PAGE FOR CONFIGURATOR OPTIONS
    const targetPage = pages[pages.length - 1]; 
    const textColor = rgb(36 / 255, 36 / 255, 2 / 255); // #242402

    // --- 3. HEADER TEXT INPUTS (SYNCED ACROSS ALL PAGES) ---
    const headerConfigs = [
      { name: 'project_name', x: 69, y: 720, width: 120, height: 16 },
      { name: 'fixture_type', x: 262, y: 720, width: 120, height: 16 },
      { name: 'project_location', x: 432, y: 720, width: 120, height: 16 }
    ];

    headerConfigs.forEach(cfg => {
      const textField = form.createTextField(cfg.name);
      pages.forEach(page => {
        textField.addToPage(page, {
          x: cfg.x,
          y: cfg.y,
          width: cfg.width,
          height: cfg.height,
          borderWidth: 0,
          backgroundColor: rgb(1, 1, 1),
          textColor: textColor,
          font: customFont,
        });
      });
      textField.setFontSize(10);
    });

    // --- 4. CONFIGURATOR RADIO GROUPS ---
    const columnXMap = {
      'WIRELESS PROTOCOL': 36,
      'ENVIRONMENT RATING': 116,
      'CCT': 233,
      'OUTPUT LEVEL': 348,
      'MOUNTING METHOD': 432,
      'FINISH': 512,
      'START FEED DIRECTION': 116,
      'START FEED LENGTH': 200,
      'END FEED DIRECTION': 233,
      'END FEED LENGTH': 315
    };

    if (Array.isArray(configurator_options) && configurator_options.length > 0) {
      const sortedSteps = configurator_options.sort((a, b) => a.option_step - b.option_step);

      sortedSteps.forEach((step) => {
        const stepName = `step_${step.option_step}`;
        const optionType = (step.option_type || '').toUpperCase();
        const optionLabel = (step.option_label || '').toUpperCase();

        const isRow2 = optionType.includes('FEED') || optionType === 'LENGTH';
        const rowStartY = isRow2 ? 460 : 650; 
        
        let anchorX = 36;
        for (const [key, xVal] of Object.entries(columnXMap)) {
          if (optionType.includes(key) || optionLabel.includes(key)) {
            anchorX = xVal;
            break;
          }
        }

        let allowedValues = [];
        try {
          allowedValues = typeof step.allowed_values_json === 'string' 
            ? JSON.parse(step.allowed_values_json) 
            : (step.allowed_values_json || []);
        } catch (e) {
          allowedValues = [];
        }

        if (step.option_type === "Length") {
          const lengthField = form.createTextField(stepName);
          lengthField.addToPage(targetPage, {
            x: 36,
            y: 460,
            width: 65,
            height: 14,
            borderWidth: 0.5,
            borderColor: textColor,
            textColor: textColor,
            font: customFont,
          });
          lengthField.setFontSize(9);
        } else if (allowedValues.length > 0) {
          const radioGroup = form.createRadioGroup(stepName);
          let defaultSelectedCode = null;

          allowedValues.forEach((valObj, valIdx) => {
            const itemY = rowStartY - (valIdx * 13);
            const valCode = String(valObj.code || valObj.value || `opt_${valIdx}`);

            radioGroup.addOptionToPage(valCode, targetPage, {
              x: anchorX,
              y: itemY,
              width: 9,
              height: 9,
              borderWidth: 0.5,
              borderColor: textColor,
            });

            if ((valObj.is_default === 1 || valIdx === 0) && !defaultSelectedCode) {
              defaultSelectedCode = valCode;
            }
          });

          if (defaultSelectedCode) {
            try {
              radioGroup.select(defaultSelectedCode);
            } catch (err) {}
          }
        }
      });
    }

    form.updateFieldAppearances(customFont);

    // 5. Save and return modified Base64
    const pdfBytes = await pdfDoc.save();
    const outputBase64 = Buffer.from(pdfBytes).toString('base64');

    return res.status(200).json({ pdf_base64: outputBase64 });
    
  } catch (error) {
    console.error('PDF Generation Error:', error);
    return res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
}