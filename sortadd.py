import re,sys
def add(path,key,expr,typ):
    s=open(path).read()
    pat=re.compile(r'(header: columnHeader\("columns", "%s"\),\n)(\s*)(meta: \{\n)?'%key)
    m=pat.search(s)
    assert m,(path,key)
    ind=m.group(2)
    line='sort: (row: %s) => %s,'%(typ,expr)
    if m.group(3):
        rep=m.group(1)+ind+m.group(3)+ind+'  '+line+'\n'
    else:
        rep=m.group(1)+ind+'meta: { '+line+' },\n'
    s=s[:m.start()]+rep+s[m.end():]
    open(path,'w').write(s)
