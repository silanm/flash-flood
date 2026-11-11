#!/usr/bin/env python3
"""As-built wiring of the ESP32 node and the Raspberry Pi hub (schemdraw 0.23), sized for one IEEE column.

Pins follow hardware/esp32_node/ESP32_Node/ESP32_Node.ino, hardware/rpi_hub/hub_io.py and rf_gateway.py.
Left to the caption: all grounds common, IRQ not connected, Pi pin numbers in brackets.
Usage: python wiring_schemdraw.py [out_dir]   -> ESP32_Wiring_asbuilt.{pdf,png}, RPi_Wiring_asbuilt.{pdf,png}
"""
import os, sys
import schemdraw
import schemdraw.elements as elm

OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))
K = 1.6           # text scale: the figures print about 3.3 in wide, so text must be large against the drawing
SP = 0.75         # pin spacing, the same on every block so the signal wires run straight
PIN_LBL = 10 * K  # pin label size
schemdraw.config(fontsize=10 * K, lw=1.2)


def bold(text):
    """Bold part name (mathtext: the label API has no font weight). U+2010 keeps a real hyphen, not a minus."""
    return "\n".join("$\\mathbf{" + ln.replace(" ", "\\ ").replace("-", "\u2010").replace("×", "\\times ") + "}$"
                     for ln in text.split("\n"))


def ic_pins(right=None, left=None):
    """Pins per side, listed top to bottom; None leaves a gap row."""
    pins = []
    for side, names in (("R", right), ("L", left)):
        if names:
            n = len(names)
            for i, nm in enumerate(names):
                if nm:
                    pins.append(elm.IcPin(name=nm[0], anchorname=nm[1], side=side, slot=f"{n - i}/{n}"))
    return pins


def mcu_ic(d, label, right, left, padw):
    return d.add(elm.Ic(pins=ic_pins(right=right, left=left), pinspacing=SP, edgepadW=padw, edgepadH=0.4,
                        leadlen=0.3, plblsize=PIN_LBL, label=bold(label), lsize=11 * K).theta(0))


def block(d, label, rows, rail=None, at=None, anchor=None, vcc_name="VCC"):
    """Peripheral: signal pins on the left, VCC (top row) and GND (bottom row) on the right with their symbols.
    rail=None: no VCC pin. Placed so pin `anchor` sits at `at`."""
    rows = rows + [None] * (2 - len(rows))
    right = [(vcc_name, "VCC") if rail else None] + [None] * (len(rows) - 2) + [("GND", "GND")]
    e = elm.Ic(pins=ic_pins(left=rows, right=right), pinspacing=SP, edgepadW=3.3, edgepadH=0.35,
               leadlen=0.3, plblsize=PIN_LBL, label=bold(label), lsize=9 * K)
    b = d.add(e.theta(0).anchor(anchor).at(at))   # theta(0): an Ic otherwise turns with the last element drawn
    if rail:
        d.add(elm.Line().at(b.VCC).right(0.4))
        b.vcc_tap = d.here
        d.add(elm.Line().up(0.2))
        d.add(elm.Vdd().label(rail, fontsize=8 * K))
    d.add(elm.Line().at(b.GND).right(0.4))
    d.add(elm.Ground())
    return b


def decoupling(d, b):
    """Capacitor from the module's VCC to ground, next to the VCC symbol."""
    d.add(elm.Dot().at(b.vcc_tap))
    d.add(elm.Line().at(b.vcc_tap).right(0.7))
    d.add(elm.Capacitor().down(0.9).label("C", loc="bot", fontsize=8 * K))
    d.add(elm.Ground())


def power_left(d, pin, rail):
    """MCU supply pin on the left side: rail symbol, or ground when rail is None."""
    d.add(elm.Line().at(pin).left(0.4))
    if rail:
        d.add(elm.Line().up(0.2))
        d.add(elm.Vdd().label(rail, fontsize=8 * K))
    else:
        d.add(elm.Ground())


def wires(d, a, b, names):
    for p in names:
        d.add(elm.Line().at(getattr(a, p)).to(getattr(b, p)))


# ---------------------------------------------------------------- ESP32 node
def esp32():
    with schemdraw.Drawing(show=False) as d:
        right = [("GPIO27", "TRIG"), ("GPIO26", "ECHO"), None, None,
                 ("GPIO21", "SDA"), ("GPIO22", "SCL"), None, None,
                 ("GPIO5", "CSN"), ("GPIO4", "CE"), ("GPIO18", "SCK"), ("GPIO23", "MOSI"), ("GPIO19", "MISO")]
        left = [None, ("5V", "V5"), None, ("3V3", "V33")] + [None] * (len(right) - 5) + [("GND", "GND")]
        mcu = mcu_ic(d, "ESP32", right, left, 3.4)
        power_left(d, mcu.V5, "5 V")
        power_left(d, mcu.V33, "3.3 V")
        power_left(d, mcu.GND, None)
        x = mcu.TRIG[0] + 3.4

        # HC-SR04: 5 V part, echo through a 10k/20k divider (5 V x 20/30 = 3.33 V)
        hc = block(d, "HC-SR04", [("Trig", "TRIG"), ("Echo", "ECHO")], rail="5 V", at=(x, mcu.TRIG[1]), anchor="TRIG")
        d.add(elm.Line().at(mcu.TRIG).to(hc.TRIG))
        d.add(elm.Resistor().at(hc.ECHO).left(1.6).label("10k", loc="top", fontsize=8 * K))
        node = d.add(elm.Line().left(0.4))
        d.add(elm.Dot())
        d.add(elm.Line().at(node.end).to(mcu.ECHO))
        d.add(elm.Resistor().at(node.end).down(1.0).label("20k", loc="bot", fontsize=8 * K))
        d.add(elm.Ground())

        # SHT30 breakout (has its own I2C pull-ups)
        sht = block(d, "SHT30", [("SDA", "SDA"), ("SCL", "SCL")], rail="3.3 V", vcc_name="VIN",
                    at=(x, mcu.SDA[1]), anchor="SDA")
        wires(d, mcu, sht, ("SDA", "SCL"))

        # nRF24L01 on VSPI, IRQ not connected, decoupling capacitor at the module
        rf = block(d, "nRF24L01", [("CSN", "CSN"), ("CE", "CE"), ("SCK", "SCK"), ("MOSI", "MOSI"),
                                   ("MISO", "MISO"), ("IRQ", "IRQ")], rail="3.3 V", at=(x, mcu.CSN[1]), anchor="CSN")
        wires(d, mcu, rf, ("CSN", "CE", "SCK", "MOSI", "MISO"))
        decoupling(d, rf)
        for ext in ("pdf", "png"):
            d.save(os.path.join(OUT, f"ESP32_Wiring_asbuilt.{ext}"), dpi=300)


# ---------------------------------------------------------------- Raspberry Pi hub
def rpi():
    with schemdraw.Drawing(show=False) as d:
        right = [("GPIO8 (24)", "CSN"), ("GPIO25 (22)", "CE"), ("GPIO11 (23)", "SCK"),
                 ("GPIO10 (19)", "MOSI"), ("GPIO9 (21)", "MISO"), None, None, None,
                 ("GPIO4 (7)", "SDA"), ("GPIO5 (29)", "SCL"), None, None, None,
                 ("GPIO18 (12)", "BUZ"), None, None, None,
                 ("GPIO22 (15)", "R"), ("GPIO23 (16)", "G"), ("GPIO24 (18)", "B"), None, None,
                 ("GPIO17 (11)", "BTN")]
        left = [None, ("3V3 (1,17)", "V33")] + [None] * (len(right) - 3) + [("GND", "GND")]
        pi = mcu_ic(d, "Raspberry\nPi 4", right, left, 4.4)
        power_left(d, pi.V33, "3.3 V")
        power_left(d, pi.GND, None)
        x = pi.CSN[0] + 2.4

        rf = block(d, "nRF24L01", [("CSN", "CSN"), ("CE", "CE"), ("SCK", "SCK"), ("MOSI", "MOSI"),
                                   ("MISO", "MISO"), ("IRQ", "IRQ")], rail="3.3 V", at=(x, pi.CSN[1]), anchor="CSN")
        wires(d, pi, rf, ("CSN", "CE", "SCK", "MOSI", "MISO"))
        decoupling(d, rf)

        lcd = block(d, "LCD 20×4", [("SDA", "SDA"), ("SCL", "SCL")], rail="3.3 V",
                    at=(x, pi.SDA[1]), anchor="SDA")
        wires(d, pi, lcd, ("SDA", "SCL"))

        bz = block(d, "Buzzer", [("I/O", "IO")], rail="3.3 V", at=(x, pi.BUZ[1]), anchor="IO")
        d.add(elm.Line().at(pi.BUZ).to(bz.IO))

        led = block(d, "RGB LED", [("R", "R"), ("G", "G"), ("B", "B")], at=(x, pi.R[1]), anchor="R")
        wires(d, pi, led, "RGB")

        d.add(elm.Line().at(pi.BTN).right(0.8))
        d.add(elm.Button().right(1.0).label("Ack", loc="top", fontsize=8 * K))
        d.add(elm.Line().right(0.3))
        d.add(elm.Line().down(0.2))
        d.add(elm.Ground())
        for ext in ("pdf", "png"):
            d.save(os.path.join(OUT, f"RPi_Wiring_asbuilt.{ext}"), dpi=300)


esp32()
rpi()
print("saved to", OUT)
