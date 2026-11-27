function parseIntelHex(hexText) {
            const segments=[];
            let upperAddress=0, eof=false;
            for (const line of hexText.split(/\r?\n/).map(line=>line.trim()).filter(Boolean)) {
                if (eof || !/^:[0-9A-Fa-f]+$/.test(line) || line.length<11 || line.length%2!==1) throw new Error('Invalid Intel HEX record');
                const bytes=Uint8Array.from(line.slice(1).match(/../g),value=>parseInt(value,16));
                if (bytes.length!==bytes[0]+5 || bytes.reduce((sum,value)=>sum+value,0)%256!==0) throw new Error('Invalid Intel HEX record length or checksum');
                const count=bytes[0], address=bytes[1]*256+bytes[2], type=bytes[3];
                if (type===0) {
                    const previous=segments.at(-1), absolute=upperAddress+address;
                    if (previous && previous.address+previous.data.length===absolute) {
                        const joined=new Uint8Array(previous.data.length+count);
                        joined.set(previous.data); joined.set(bytes.slice(4,4+count),previous.data.length); previous.data=joined;
                    } else segments.push({address:absolute,data:bytes.slice(4,4+count)});
                } else if (type===1 && count===0 && address===0) eof=true;
                else if ((type===2 || type===4) && count===2 && address===0) upperAddress=(bytes[4]*256+bytes[5])*(type===2?16:65536);
                else if ((type===3 || type===5) && count===4) continue;
                else throw new Error('Unsupported Intel HEX record');
            }
            if (!eof) throw new Error('Missing Intel HEX end record');
            segments.sort((a,b)=>a.address-b.address);
            for (let i=1;i<segments.length;i++) if (segments[i].address<segments[i-1].address+segments[i-1].data.length) throw new Error('Overlapping firmware segments');
            return segments;
        }
if (typeof module !== "undefined") module.exports = { parseIntelHex };
