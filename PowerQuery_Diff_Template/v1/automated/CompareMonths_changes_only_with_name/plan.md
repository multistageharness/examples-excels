### Python (The XML Hack)

If your script **must dynamically generate or alter the `M` code** based on variables (meaning a static template won't work), **Python is the better choice**, but you have to get your hands dirty.

Because an `.xlsx` file is just a renamed `.zip` archive containing XML files, you can use Python to physically crack the file open and inject the code yourself. Python's standard `zipfile` and `lxml` libraries make this much easier than Node.

Here is the exact workflow you would use in Python:

1. **Modify the Sheets:** Use `openpyxl` to load the workbook, clone the sheet, apply your highlights, and save a temporary `.xlsx` file.
2. **Unzip the Workbook:** Use Python's `zipfile` module to extract the temporary `.xlsx` file into a directory.
3. **Inject the `M` Code:** \* Navigate to the `customXml` folder inside the extracted files.

- Locate the XML item (usually `item1.xml` or similar) that stores the Power Query connection string and base64-encoded `M` code.
- Use Python's `xml.etree.ElementTree` or `lxml` to find the `<query>` node and replace the inner text with your dynamic `M` script.

4. **Re-zip:** Compress the directory back into a `.zip` and change the extension to `.xlsx`.

### The Verdict

- **If you can use a static template with the query already built:** Use **Node.js (`exceljs`)**. It handles sheet cloning and highlighting beautifully, and is less likely to corrupt the existing Power Query XML upon saving.
- **If you must dynamically inject or alter the `M` code string on the fly:** Use **Python**. You will have to build a script that modifies the sheets with `openpyxl`, unzips the file, surgically alters the XML to inject your `M` code, and zips it back together.

install `pip install openpyxl`

Script

```
import os
import shutil
import zipfile
import base64
import xml.etree.ElementTree as ET
from openpyxl import load_workbook

def modify_sheets(input_file, temp_file):
    """Step 1: Modify the workbook using openpyxl."""
    print("Modifying sheets...")
    wb = load_workbook(input_file)

    # Example modification: Clone a sheet and rename it
    if "Jan" in wb.sheetnames:
        source_sheet = wb["Jan"]
        new_sheet = wb.copy_worksheet(source_sheet)
        new_sheet.title = "Feb"

        # Example: Add some basic data/highlighting logic here
        new_sheet["A1"] = "Updated by Python"

    wb.save(temp_file)
    wb.close()

def inject_m_code(temp_file, final_file, new_m_code):
    """Steps 2-4: Unzip, inject M code into XML, and re-zip."""
    extract_dir = "temp_extracted_xlsx"

    # Step 2: Unzip the modified workbook
    print("Unzipping workbook...")
    with zipfile.ZipFile(temp_file, 'r') as zip_ref:
        zip_ref.extractall(extract_dir)

    # Step 3: Locate and inject the M code
    print("Injecting M code...")
    custom_xml_dir = os.path.join(extract_dir, 'customXml')

    if not os.path.exists(custom_xml_dir):
        raise Exception("customXml directory not found. Is there an existing Power Query in this file?")

    # Find the specific XML file containing the Mashup data (usually item1.xml, item2.xml, etc.)
    # Note: You may need to iterate through files to find the exact one containing your query namespace.
    target_xml = os.path.join(custom_xml_dir, 'item1.xml')

    # Register namespaces to prevent ET from replacing them with 'ns0:'
    ET.register_namespace("", "http://schemas.openxmlformats.org/officeDocument/2006/customXml")

    tree = ET.parse(target_xml)
    root = tree.getroot()

    # Power Query M code is typically stored as a Base64 encoded string within a DataMashup node.
    # The exact tag depends on the Excel version, but we will search for the node containing the encoded script.
    # Note: This targets a generalized structure. You may need to adjust the XPath based on your specific template.
    for elem in root.iter():
        if elem.text and is_base64_m_code(elem.text):
            print("Found existing M Code node. Overwriting...")
            # Encode your dynamic string to Base64
            encoded_new_code = base64.b64encode(new_m_code.encode('utf-16le')).decode('utf-8')
            elem.text = encoded_new_code
            break

    # Save the modified XML back to the unzipped directory
    tree.write(target_xml, xml_declaration=True, encoding='UTF-8')

    # Step 4: Re-zip the directory back into an .xlsx file
    print("Repackaging workbook...")
    repack_excel(extract_dir, final_file)

    # Cleanup temporary files and directories
    shutil.rmtree(extract_dir)
    os.remove(temp_file)
    print(f"Success! Final file saved as {final_file}")

def is_base64_m_code(text):
    """Heuristic to check if a text string is likely the Base64 encoded Power Query mashup."""
    try:
        # Check if it decodes cleanly and contains common M code keywords
        decoded = base64.b64decode(text).decode('utf-16le', errors='ignore')
        return "let" in decoded and "in" in decoded
    except Exception:
        return False

def repack_excel(source_dir, output_filename):
    """Zips a directory back into a functional .xlsx format without nesting issues."""
    with zipfile.ZipFile(output_filename, 'w', zipfile.ZIP_DEFLATED) as zipf:
        for root, dirs, files in os.walk(source_dir):
            for file in files:
                file_path = os.path.join(root, file)
                # Ensure the path inside the zip starts at the root of the extracted folder
                arcname = os.path.relpath(file_path, source_dir)
                zipf.write(file_path, arcname)

# --- Execution ---
if __name__ == "__main__":
    template_path = "template_with_query.xlsx"
    temp_path = "temp_modified.xlsx"
    final_output = "Final_Automated_Report.xlsx"

    # Your dynamic M script generated on the fly
    dynamic_m_script = """let
    Source = Excel.CurrentWorkbook(){[Name="tbl_Feb"]}[Content],
    Filtered = Table.SelectRows(Source, each [Status] = "Active")
in
    Filtered"""

    try:
        modify_sheets(template_path, temp_path)
        inject_m_code(temp_path, final_output, dynamic_m_script)
    except Exception as e:
        print(f"Error during execution: {e}")
```

### Important Caveats for this Approach

- **The Base64 Payload:** Excel does not store M code as plain text in the XML. It stores it as a Base64-encoded string, which is often encoded in `UTF-16LE` (Little Endian). The `is_base64_m_code` helper function handles checking and re-encoding this correctly.
- **The Template Requirement:** You _must_ start with a template `.xlsx` file that already has a blank or placeholder Power Query connection built into it. If you try to build the `customXml` folder structure from scratch using Python, Excel will likely throw a corruption error upon opening.
- **Targeting the Right Node:** Depending on how many custom properties are in your template, the M code might be in `item1.xml`, `item2.xml`, or `item3.xml`. If the script fails to find it, unzip your template manually, open the `customXml` folder, and grep for `"let"` to see which file contains the payload.
