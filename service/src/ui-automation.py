"""
PAN UI Automation — gives Claude eyes and hands on the desktop.

Commands:
  screenshot              — capture full screen, return base64 JPEG
  screenshot <region>     — capture region (x,y,w,h), return base64 JPEG
  list_windows            — list all visible windows with titles and positions
  focus <title>           — bring window to front by title (partial match)
  click <x> <y>           — click at screen coordinates
  doubleclick <x> <y>     — double-click
  rightclick <x> <y>      — right-click
  type <text>             — type text at current cursor position
  hotkey <keys>           — press key combination (e.g. "ctrl+c", "alt+tab")
  moveto <x> <y>          — move mouse without clicking
  scroll <amount>         — scroll up (positive) or down (negative)
  find_element <name>     — find UI element by name/text in focused window
  read_screen             — OCR the screen (requires screenshot + Claude Vision)

Usage: python ui-automation.py <command> [args...]
Returns JSON to stdout.
"""

import sys
import json
import base64
import io

def screenshot(region=None):
    """Capture screen or region, return base64 JPEG. Captures ALL monitors."""
    from PIL import Image, ImageGrab

    if region:
        parts = [int(x) for x in region.split(',')]
        # Use bbox (left, top, right, bottom) for multi-monitor support
        img = ImageGrab.grab(bbox=(parts[0], parts[1], parts[0]+parts[2], parts[1]+parts[3]), all_screens=True)
    else:
        img = ImageGrab.grab(all_screens=True)

    # Resize to max 1920px wide for efficiency
    if img.width > 1920:
        ratio = 1920 / img.width
        img = img.resize((1920, int(img.height * ratio)), Image.LANCZOS)

    buf = io.BytesIO()
    img.save(buf, format='JPEG', quality=80)
    b64 = base64.b64encode(buf.getvalue()).decode('utf-8')
    return {'ok': True, 'image_base64': b64, 'width': img.width, 'height': img.height}

def list_windows():
    """List all visible windows."""
    import pygetwindow as gw
    windows = []
    for w in gw.getAllWindows():
        if w.title and w.visible and w.width > 50 and w.height > 50:
            windows.append({
                'title': w.title,
                'x': w.left, 'y': w.top,
                'width': w.width, 'height': w.height,
                'active': w.isActive,
                'minimized': w.isMinimized
            })
    return {'ok': True, 'windows': windows}

def focus_window(title_search):
    """Bring window to front by partial title match."""
    import pygetwindow as gw
    search = title_search.lower()
    for w in gw.getAllWindows():
        if search in w.title.lower():
            try:
                if w.isMinimized:
                    w.restore()
                w.activate()
                return {'ok': True, 'focused': w.title}
            except Exception as e:
                return {'ok': False, 'error': str(e)}
    return {'ok': False, 'error': f'No window matching "{title_search}"'}

def screenshot_window(title_search):
    """Find window by title, focus it, maximize it, and screenshot it."""
    import pygetwindow as gw
    from PIL import Image
    import pyautogui
    import time

    search = title_search.lower()
    target = None
    for w in gw.getAllWindows():
        if search in w.title.lower() and w.width > 50 and w.height > 50:
            target = w
            break

    if not target:
        # Fallback: use ctypes to find by URL in Electron windows
        # All Electron windows may be titled "PAN" — match by position/size hint
        return {'ok': False, 'error': f'No window matching "{title_search}"'}

    try:
        if target.isMinimized:
            target.restore()
            time.sleep(0.3)
        target.maximize()
        time.sleep(0.3)
        target.activate()
        time.sleep(0.5)
    except Exception:
        pass

    # Screenshot the now-maximized window using all_screens for multi-monitor
    from PIL import ImageGrab
    img = ImageGrab.grab(bbox=(target.left, target.top, target.left + target.width, target.top + target.height), all_screens=True)

    if img.width > 1920:
        ratio = 1920 / img.width
        img = img.resize((1920, int(img.height * ratio)), Image.LANCZOS)

    import io, base64
    buf = io.BytesIO()
    img.save(buf, format='JPEG', quality=80)
    b64 = base64.b64encode(buf.getvalue()).decode('utf-8')
    return {'ok': True, 'image_base64': b64, 'width': img.width, 'height': img.height,
            'window_title': target.title, 'maximized': True}


def click(x, y):
    """Click at screen coordinates."""
    import pyautogui
    pyautogui.click(int(x), int(y))
    return {'ok': True, 'action': 'click', 'x': int(x), 'y': int(y)}

def doubleclick(x, y):
    """Double-click at screen coordinates."""
    import pyautogui
    pyautogui.doubleClick(int(x), int(y))
    return {'ok': True, 'action': 'doubleclick', 'x': int(x), 'y': int(y)}

def rightclick(x, y):
    """Right-click at screen coordinates."""
    import pyautogui
    pyautogui.rightClick(int(x), int(y))
    return {'ok': True, 'action': 'rightclick', 'x': int(x), 'y': int(y)}

def type_text(text):
    """Type text at current cursor position."""
    import pyautogui
    pyautogui.write(text, interval=0.02)
    return {'ok': True, 'action': 'type', 'text': text}

def hotkey(keys):
    """Press key combination (e.g. 'ctrl+c', 'alt+tab', 'enter')."""
    import pyautogui
    key_list = [k.strip() for k in keys.split('+')]
    pyautogui.hotkey(*key_list)
    return {'ok': True, 'action': 'hotkey', 'keys': key_list}

def moveto(x, y):
    """Move mouse to coordinates."""
    import pyautogui
    pyautogui.moveTo(int(x), int(y))
    return {'ok': True, 'action': 'moveto', 'x': int(x), 'y': int(y)}

def scroll(amount):
    """Scroll up (positive) or down (negative)."""
    import pyautogui
    pyautogui.scroll(int(amount))
    return {'ok': True, 'action': 'scroll', 'amount': int(amount)}

def find_element(name):
    """Find UI element by name in the focused window using Windows UI Automation."""
    import uiautomation as auto

    try:
        # Get the focused window
        focused = auto.GetForegroundControl()
        if not focused:
            return {'ok': False, 'error': 'No focused window'}

        search = name.lower()
        results = []

        # Search for controls matching the name
        for control, depth in auto.WalkControl(focused, maxDepth=6):
            ctrl_name = (control.Name or '').lower()
            ctrl_type = control.ControlTypeName or ''

            if search in ctrl_name:
                rect = control.BoundingRectangle
                results.append({
                    'name': control.Name,
                    'type': ctrl_type,
                    'x': rect.left + (rect.right - rect.left) // 2,
                    'y': rect.top + (rect.bottom - rect.top) // 2,
                    'width': rect.right - rect.left,
                    'height': rect.bottom - rect.top
                })

            if len(results) >= 10:
                break

        return {'ok': True, 'elements': results, 'window': focused.Name}
    except Exception as e:
        return {'ok': False, 'error': str(e)}

def get_window_elements():
    """Get interactive elements in the focused window (shallow scan for speed)."""
    import uiautomation as auto

    try:
        focused = auto.GetForegroundControl()
        if not focused:
            return {'ok': False, 'error': 'No focused window'}

        elements = []
        interactive_types = {'ButtonControl', 'EditControl', 'ComboBoxControl',
                           'CheckBoxControl', 'RadioButtonControl', 'ListItemControl',
                           'MenuItemControl', 'TabItemControl', 'HyperlinkControl',
                           'TreeItemControl'}

        import time
        start_time = time.time()
        for control, depth in auto.WalkControl(focused, maxDepth=3):
            # Timeout after 5 seconds to avoid hanging on complex apps
            if time.time() - start_time > 5:
                break
            ctrl_type = control.ControlTypeName or ''
            if ctrl_type in interactive_types and control.Name:
                rect = control.BoundingRectangle
                if rect.right - rect.left > 5 and rect.bottom - rect.top > 5:
                    elements.append({
                        'name': control.Name,
                        'type': ctrl_type,
                        'x': rect.left + (rect.right - rect.left) // 2,
                        'y': rect.top + (rect.bottom - rect.top) // 2,
                    })

            if len(elements) >= 30:
                break

        return {'ok': True, 'elements': elements, 'window': focused.Name}
    except Exception as e:
        return {'ok': False, 'error': str(e)}


def click_element_by_name(name):
    """Find a UI element by name in the focused window and click it."""
    import uiautomation as auto
    import pyautogui

    try:
        focused = auto.GetForegroundControl()
        if not focused:
            return {'ok': False, 'error': 'No focused window'}

        search = name.lower()
        import time
        start_time = time.time()

        for control, depth in auto.WalkControl(focused, maxDepth=4):
            if time.time() - start_time > 5:
                break
            ctrl_name = (control.Name or '').lower()
            if search in ctrl_name:
                rect = control.BoundingRectangle
                x = rect.left + (rect.right - rect.left) // 2
                y = rect.top + (rect.bottom - rect.top) // 2
                pyautogui.click(x, y)
                return {'ok': True, 'clicked': control.Name, 'type': control.ControlTypeName, 'x': x, 'y': y}

        return {'ok': False, 'error': f'Element "{name}" not found'}
    except Exception as e:
        return {'ok': False, 'error': str(e)}

def read_window_text():
    """Read all visible text from the focused window."""
    import uiautomation as auto

    try:
        focused = auto.GetForegroundControl()
        if not focused:
            return {'ok': False, 'error': 'No focused window'}

        texts = []
        import time
        start_time = time.time()

        for control, depth in auto.WalkControl(focused, maxDepth=3):
            if time.time() - start_time > 5:
                break
            if control.Name:
                texts.append(control.Name)
            if len(texts) >= 100:
                break

        return {'ok': True, 'window': focused.Name, 'text': '\n'.join(texts)}
    except Exception as e:
        return {'ok': False, 'error': str(e)}


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps({'ok': False, 'error': 'No command specified'}))
        sys.exit(1)

    cmd = sys.argv[1].lower()
    args = sys.argv[2:]

    try:
        if cmd == 'screenshot':
            result = screenshot(args[0] if args else None)
        elif cmd == 'list_windows':
            result = list_windows()
        elif cmd == 'screenshot_window':
            result = screenshot_window(' '.join(args))
        elif cmd == 'focus':
            result = focus_window(' '.join(args))
        elif cmd == 'click':
            # Support both "click 600 300" and "click 600,300"
            if len(args) == 1 and ',' in args[0]:
                parts = args[0].split(',')
                result = click(parts[0], parts[1])
            else:
                result = click(args[0], args[1])
        elif cmd == 'doubleclick':
            result = doubleclick(args[0], args[1])
        elif cmd == 'rightclick':
            result = rightclick(args[0], args[1])
        elif cmd == 'type':
            result = type_text(' '.join(args))
        elif cmd == 'hotkey':
            result = hotkey(args[0])
        elif cmd == 'moveto':
            result = moveto(args[0], args[1])
        elif cmd == 'scroll':
            result = scroll(args[0])
        elif cmd == 'find_element':
            result = find_element(' '.join(args))
        elif cmd == 'elements':
            result = get_window_elements()
        elif cmd == 'click_by_name':
            result = click_element_by_name(' '.join(args))
        elif cmd == 'read_text':
            result = read_window_text()
        else:
            result = {'ok': False, 'error': f'Unknown command: {cmd}'}
    except Exception as e:
        result = {'ok': False, 'error': str(e)}

    print(json.dumps(result))
